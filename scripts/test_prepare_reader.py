"""Small original fixtures for additive reader presentation metadata."""
import copy
import importlib.util
import io
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from scripts import import_books as importer
from scripts import prepare_reader as prepare


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.config = {"fixture": {"editionId": "edition-1", "tokens": {"badtoken": "good token"}, "occurrences": []}}

    def test_ranges_use_utf16_after_an_astral_character(self):
        text = "😀 badtoken follows."
        changes = prepare.corrections_for(text, "fixture", "edition-1", config=self.config)
        self.assertEqual(changes, [{"charStart": 3, "charEnd": 11, "sourceText": "badtoken", "replacementText": "good token"}])
        self.assertEqual(prepare.corrected_display_text(text, changes), "😀 good token follows.")
        self.assertEqual(text, "😀 badtoken follows.")

    def test_case_preservation_and_whole_token_only(self):
        changes = prepare.corrections_for("BADTOKEN Badtoken badtoken-like MixedBadtoken", "fixture", "edition-1", config=self.config)
        self.assertEqual([c["replacementText"] for c in changes], ["GOOD TOKEN", "Good token"])

    def test_stale_edition_and_other_book_have_no_corrections(self):
        self.assertEqual(prepare.corrections_for("badtoken", "fixture", "edition-2", config=self.config), [])
        self.assertEqual(prepare.corrections_for("badtoken", "another", "edition-1", config=self.config), [])

    def test_occurrence_override_requires_an_exact_complete_word(self):
        config = copy.deepcopy(self.config)
        config["fixture"]["occurrences"] = [{"chapterIndex": 2, "paragraphIndex": 3, "charStart": 0, "charEnd": 8, "sourceText": "badtoken", "replacementText": "specific repair"}]
        changes = prepare.corrections_for("badtoken", "fixture", "edition-1", 2, 3, config)
        self.assertEqual(changes[0]["replacementText"], "specific repair")
        config["fixture"]["occurrences"][0]["charEnd"] = 3
        with self.assertRaises(importer.ImportFailure):
            prepare.corrections_for("badtoken", "fixture", "edition-1", 2, 3, config)

    def test_real_words_and_names_are_not_guessed(self):
        self.assertEqual(prepare.corrections_for("Diem Patterson isness", "fixture", "edition-1", config=self.config), [])

    def test_invalid_token_configuration_is_rejected(self):
        for tokens in ({"two words": "repair"}, {"Badtoken": "repair"}, {"badtoken": "<script>"}, [], {"badtoken": "  "}):
            config = copy.deepcopy(self.config)
            config["fixture"]["tokens"] = tokens
            with self.subTest(tokens=tokens), self.assertRaises(importer.ImportFailure):
                prepare.corrections_for("badtoken", "fixture", "edition-1", config=config)

    def test_unreachable_and_duplicate_occurrences_are_rejected(self):
        canonical = {"editionId": "edition-1", "chapters": [{"paragraphs": ["badtoken"]}]}
        entry = {"chapterIndex": 0, "paragraphIndex": 0, "charStart": 0, "charEnd": 8, "sourceText": "badtoken", "replacementText": "good token"}
        config = copy.deepcopy(self.config)
        config["fixture"]["occurrences"] = [entry]
        prepare.validate_book_occurrences(config, "fixture", canonical)
        for changes in ({"chapterIndex": 1}, {"paragraphIndex": -1}, {"charStart": True}, {"charEnd": 4}):
            config["fixture"]["occurrences"] = [{**entry, **changes}]
            with self.subTest(changes=changes), self.assertRaises(importer.ImportFailure):
                prepare.validate_book_occurrences(config, "fixture", canonical)
        config["fixture"]["occurrences"] = [entry, entry]
        with self.assertRaises(importer.ImportFailure):
            prepare.validate_book_occurrences(config, "fixture", canonical)


class SourceAndPlacementTests(unittest.TestCase):
    def test_optional_source_metadata_does_not_change_default_output(self):
        fixture = [{"id": "c1", "title": "A heading", "paragraphs": ["A heading", "Original prose remains."], "_source": [{"path": "body.xhtml", "index": 0, "heading": True}, {"path": "body.xhtml", "index": 1, "heading": False}]}]
        default, _ = importer.clean_chapters(copy.deepcopy(fixture), "fixture", "A book", {})
        enriched, _ = importer.clean_chapters(copy.deepcopy(fixture), "fixture", "A book", {}, include_source=True)
        self.assertNotIn("_source", default[0])
        self.assertEqual(default, [{k: v for k, v in c.items() if k != "_source"} for c in enriched])
        self.assertEqual(enriched[0]["_source"][0]["index"], 1)

    def test_entire_bold_source_heading_differs_from_a_bold_fragment(self):
        root = ET.fromstring('<html><body><p><span><strong>A section title</strong></span></p><p><strong>A bold start</strong> followed by original body text.</p></body></html>')
        extracted = importer.extract_text(root, set())
        self.assertTrue(extracted.paragraph_attributes[0]["fullBold"])
        self.assertNotIn("fullBold", extracted.paragraph_attributes[1])
        self.assertEqual(prepare.paragraph_kind(extracted.paragraphs[0], extracted.paragraph_attributes[0], "subconscious-mind", 0), "subheading")
        self.assertEqual(prepare.paragraph_kind(extracted.paragraphs[1], extracted.paragraph_attributes[1], "subconscious-mind", 1), "body")

    def test_image_events_match_importer_paragraph_boundaries(self):
        root = ET.fromstring('<html><body><h2>A heading</h2><p><img src="figure.jpg" /></p><p>Actual body text.</p></body></html>')
        paragraphs, events = prepare.image_events(root)
        self.assertEqual(paragraphs, importer.extract_text(root, set()).paragraphs)
        self.assertEqual(events[0]["sourceParagraphBoundary"], 1)

    def test_svg_wrapper_resolves_only_its_raster_reference(self):
        root = ET.fromstring('<html xmlns:xlink="http://www.w3.org/1999/xlink"><body><svg><image xlink:href="figure.jpg" /></svg><p>Body text.</p></body></html>')
        _, events = prepare.image_events(root)
        self.assertEqual(events[0]["href"], "figure.jpg")
        with self.assertRaises(importer.ImportFailure):
            importer.resource_path("body.xhtml", "https://example.org/image.jpg")

    def test_figure_after_removed_heading_anchors_before_retained_prose(self):
        event = {"spineIndex": 0, "sourceParagraphBoundary": 2, "inline": False, "sourceDocument": "heading.xhtml"}
        sources = [{"path": "body.xhtml", "index": 0, "chapterIndex": 1, "paragraphIndex": 0}]
        self.assertEqual(prepare.image_placement(event, sources, {"heading.xhtml": 0, "body.xhtml": 1}), (1, 0))

    def test_covers_adverts_and_decorations_are_excluded(self):
        self.assertFalse(prepare.meaningful_image("atomic-habits", "cover.jpg", "body.xhtml", True))
        self.assertFalse(prepare.meaningful_image("rich-dad-poor-dad", "f0181-01.jpg", "backmatter_1.xhtml", False))
        self.assertFalse(prepare.meaningful_image("five-am-club", "sb_image1.jpg", "body.xhtml", False))
        self.assertTrue(prepare.meaningful_image("atomic-habits", "invalid_page_number.jpg", "body.xhtml", False))

    def test_source_epigraph_style_and_real_subheadings_are_preserved(self):
        self.assertEqual(prepare.paragraph_kind("An original quotation.", {"tag": "p", "classes": ["cn_epi"]}, "five-am-club", 0), "quote")
        self.assertEqual(prepare.paragraph_kind("A REAL SUBHEADING", {"tag": "p", "classes": ["bold", "calibre29"]}, "seven-habits", 3), "subheading")
        self.assertEqual(prepare.paragraph_kind("A PERSON NAME", {"tag": "p"}, "seven-habits", 1), "body")

    def test_circa_life_dates_are_body_text_rather_than_lettered_lists(self):
        self.assertEqual(prepare.paragraph_kind("c. a.d. 46-120", {"tag": "p"}, "laws-of-power", 2), "body")
        self.assertEqual(prepare.paragraph_kind("c. The third original item.", {"tag": "p"}, "laws-of-power", 2), "list-item")

    def test_verified_book_styles_preserve_internal_structure(self):
        fixtures = [
            ("atomic-habits", "Chapter Summary", "x06-Chapter-Summary-Head", "subheading"),
            ("atomic-habits", "A table title", "x08-Table-Title", "caption"),
            ("atomic-habits", "A verse line", "x06-Verse", "quote"),
            ("rich-dad-poor-dad", "A section heading", "subheading", "subheading"),
            ("five-am-club", "A main section", "a_hd", "heading"),
            ("five-am-club", "A smaller section", "b_hd", "subheading"),
            ("five-am-club", "An extracted passage", "ext1", "quote"),
            ("five-am-club", "Truth #1: An original item.", "list1", "list-item"),
        ]
        for book_id, text, class_name, expected in fixtures:
            with self.subTest(book_id=book_id, class_name=class_name):
                self.assertEqual(prepare.paragraph_kind(text, {"tag": "p", "classes": [class_name]}, book_id, 4), expected)
        self.assertEqual(prepare.paragraph_kind("PRINCIPLE 2", {"tag": "p", "classes": ["bold", "calibre4"]}, "win-friends", 3), "subheading")
        self.assertEqual(prepare.paragraph_kind("AUTHOR NAME", {"tag": "p", "classes": ["bold", "calibre7"]}, "win-friends", 3), "body")

    def test_reviewed_figure_description_uses_the_exact_resource_basename(self):
        descriptions = {"fixture": {"Figure_01.jpg": "A diagram with a labelled sequence."}}
        self.assertEqual(prepare.image_description("fixture", "images/Figure_01.jpg", "image", "A book", "A chapter", descriptions), "A diagram with a labelled sequence.")
        self.assertEqual(prepare.image_description("fixture", "images/figure_01.jpg", "A useful source description.", "A book", "A chapter", descriptions), "A useful source description.")
        self.assertEqual(prepare.image_description("fixture", "images/other.jpg", "other.jpg", "A book", "A chapter", descriptions), "Figure from A book: A chapter")


@unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow is needed for raster preparation")
class RasterTests(unittest.TestCase):
    def image_bytes(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new("RGB", (6, 4), "white").save(output, format="PNG")
        return output.getvalue()

    def test_decoded_raster_is_deterministic_and_has_verified_dimensions(self):
        first = prepare.raster_asset(self.image_bytes())
        second = prepare.raster_asset(self.image_bytes())
        self.assertEqual(first, second)
        self.assertEqual(first[1:], (6, 4))
        self.assertTrue(first[0].startswith(b"\xff\xd8"))

    def test_active_or_corrupt_input_and_excess_pixels_are_rejected(self):
        with self.assertRaises(importer.ImportFailure):
            prepare.raster_asset(b'<svg onload="alert(1)"></svg>')
        with patch.object(prepare, "MAX_IMAGE_PIXELS", 20), self.assertRaises(importer.ImportFailure):
            prepare.raster_asset(self.image_bytes())


if __name__ == "__main__":
    unittest.main()
