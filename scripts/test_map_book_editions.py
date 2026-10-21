"""Edition location regressions using original, short fixture text."""
from copy import deepcopy
import unittest

from scripts.map_book_editions import map_editions, verified_pairs


def book(edition, chapters):
    return {"editionId": edition, "chapters": [{"id": f"section-{i}", "title": f"Section {i}", "paragraphs": paragraphs}
                                               for i, paragraphs in enumerate(chapters)]}


class EditionMappingTests(unittest.TestCase):
    def test_split_paragraphs_and_added_foreword_retain_word_ranges(self):
        old = book("old", [["The quiet garden contains several unusual blue flowers near its gate."]])
        new = book("new", [["A new foreword describes this edition."], ["The quiet garden contains several", "unusual blue flowers near its gate."]])
        manifest, report = map_editions(old, new, "fixture")
        mapped = manifest["paragraphs"]["0:0"]
        self.assertEqual(mapped["target"], {"chapterIndex": 1, "paragraphIndex": 0, "charOffset": 0})
        self.assertEqual(len(mapped["words"]), 11)
        self.assertEqual(mapped["words"][-1], [64, 68, 1, 1, 30, 34])
        self.assertEqual(report["mappedWords"], report["sourceWords"])

    def test_utf16_ranges_survive_astral_characters_and_typographic_punctuation(self):
        old = book("old", [["🌿 Ada’s carefully-made garden always welcomes visitors."]])
        new = book("new", [["Ada's carefully‐made garden always welcomes visitors."]])
        manifest, _ = map_editions(old, new, "fixture")
        first = manifest["paragraphs"]["0:0"]["words"][0]
        self.assertEqual(first[:2], [3, 8])
        self.assertEqual(first[2:], [0, 0, 0, 5])
        self.assertEqual(manifest["paragraphs"]["0:0"]["sourceLength"], 56)

    def test_missing_content_has_no_invented_anchor(self):
        old = book("old", [["This former dedication names three absent friends."]])
        new = book("new", [["Replacement chapters discuss a completely different subject."]])
        manifest, report = map_editions(old, new, "fixture")
        self.assertEqual(manifest["paragraphs"], {})
        self.assertEqual(len(report["unmappedParagraphs"]), 1)

    def test_repeated_unbounded_passage_is_ambiguous(self):
        words = "several unusual blue flowers grow beside the old gate".split()
        self.assertEqual(verified_pairs(words, words + ["separator"] + words), {})

    def test_inputs_are_not_mutated(self):
        old = book("old", [["An original sentence with enough distinct words remains intact."]])
        new = book("new", [["An original sentence with enough distinct words remains intact."]])
        before = deepcopy((old, new))
        map_editions(old, new, "fixture")
        self.assertEqual((old, new), before)

    def test_identical_identifiers_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "different edition"):
            map_editions(book("same", [["One source sentence remains."]]), book("same", [["One source sentence remains."]]), "fixture")

    def test_long_books_use_unique_monotonic_anchors(self):
        source = [f"term{i}" for i in range(4200)]
        target = ["new", "opening", "material", *source[:2000], "additional", "detail", *source[2000:]]
        pairs = verified_pairs(source, target)
        self.assertEqual(len(pairs), len(source))
        self.assertEqual(pairs[1999], 2002)
        self.assertEqual(pairs[2000], 2005)
        self.assertTrue(all(pairs[i] < pairs[i + 1] for i in range(len(source) - 1)))


if __name__ == "__main__":
    unittest.main()
