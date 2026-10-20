"""Regression checks using short, original extraction fixtures.

Run from the project directory with:
    python -m unittest scripts.test_import_books -v
"""

import json
from pathlib import Path
import unittest

from scripts import import_books as importer


def section(title, paragraphs, path="body.xhtml", start=0, classes=None, headings=(), identity="fixture"):
    classes = classes or {}
    return {
        "id": identity,
        "title": title,
        "paragraphs": list(paragraphs),
        "_source": [
            {"path": path, "index": start + i, "heading": i in headings, "tag": "p", "classes": classes.get(i, [])}
            for i in range(len(paragraphs))
        ],
    }


class CleanupRegressionTests(unittest.TestCase):
    def test_complete_law_title_moves_without_losing_first_prose(self):
        paragraphs = ["48 Laws of Power", "LAW 2", "KEEP YOUR", "OWN COUNSEL", "JUDGMENT", "The first prose paragraph remains.", "The final prose paragraph remains."]
        chapters, report = importer.clean_chapters(
            [section("LAW 2", paragraphs, "law_split_004.html")],
            "laws-of-power", "The 48 Laws of Power", {},
        )
        self.assertEqual(chapters[0]["title"], "Law 2: KEEP YOUR OWN COUNSEL")
        self.assertEqual(chapters[0]["paragraphs"], paragraphs[4:])
        self.assertEqual(report["removedParagraphs"], 4)

    def test_law_heading_without_boundary_is_rejected(self):
        with self.assertRaisesRegex(importer.ImportFailure, "JUDGMENT boundary"):
            importer.clean_chapters(
                [section("LAW 2", ["LAW 2", "A HEADING", "An opening paragraph that must not be guessed away."])],
                "laws-of-power", "The 48 Laws of Power", {},
            )

    def test_carnegie_introduction_survives_before_course_advertising(self):
        first_path = "fixture_split_000.html"
        last_path = "fixture_split_003.html"
        front = ["Publisher listing", "Preface", "A substantive introduction remains.", "PART O N E", "Working with people"]
        main = ["1", "A SIMPLE", "DEMONSTRATION", "The first chapter paragraph remains.", "The chapter ending remains."]
        end = ["A Shortcut to", "Distinction", "by Lowell Thomas", "A substantive historical introduction remains.", "Its closing paragraph remains.", "LOWELL THOMAS", "1936", "THE DALE CARNEGIE COURSES", "Register for a course.", "OTHER BOOKS", "Buy a different book."]
        front_section = section("Dale Carnegie", front, first_path, classes={3: ["calibre6"], 4: ["calibre6"]}, identity="front")
        main_section = section("1", main, first_path, start=len(front), classes={0: ["bold", "calibre4", "calibre5"], 1: ["bold", "calibre4"], 2: ["bold", "calibre4"]}, identity="main")
        tail = section("1", end, last_path)
        main_section["paragraphs"].extend(tail["paragraphs"])
        main_section["_source"].extend(tail["_source"])
        chapters, _ = importer.clean_chapters(
            [front_section, main_section], "win-friends", "How to Win Friends and Influence People",
            {first_path: {"paragraphs": front + main}, last_path: {"paragraphs": end}},
        )
        self.assertEqual(len(chapters), 3)
        self.assertEqual(chapters[1]["title"], "Part one: Working with people / 1. A SIMPLE DEMONSTRATION")
        self.assertEqual(chapters[1]["paragraphs"], main[3:])
        self.assertEqual(chapters[2]["title"], "A Shortcut to Distinction")
        self.assertEqual(chapters[2]["paragraphs"], end[2:7])
        self.assertIn(front[2], chapters[0]["paragraphs"])
        self.assertFalse(any("Register for" in p or "Buy a different" in p for c in chapters for p in c["paragraphs"]))

    def test_sign_up_container_is_removed_but_source_notes_remain(self):
        chapters, _ = importer.clean_chapters(
            [
                section("Introduction", ["Introduction", "Original explanatory prose remains."], identity="intro"),
                section("Publisher news", ["Read another book", "Register for offers"], "next-reads.xhtml", identity="ad"),
                section("Notes", ["Notes", "A substantive source note remains."], "notes.xhtml", identity="notes"),
            ], "atomic-habits", "Atomic Habits", {},
        )
        self.assertEqual([c["title"] for c in chapters], ["Introduction", "Notes"])
        self.assertEqual(chapters[1]["paragraphs"], ["A substantive source note remains."])

    def test_numbered_chapter_blocks_do_not_duplicate_reader_title(self):
        chapters, _ = importer.clean_chapters(
            [section("1. A Demonstration", ["Chapter 1", "A Demonstration", "An opening epigraph remains.", "The first prose paragraph remains."])],
            "five-am-club", "The 5 AM Club", {},
        )
        self.assertEqual(chapters[0]["paragraphs"], ["An opening epigraph remains.", "The first prose paragraph remains."])

    def test_short_contents_label_uses_complete_source_heading(self):
        chapters, _ = importer.clean_chapters(
            [
                section("A LONG HEADING THER...", ["The Power of Now", "A LONG HEADING THERE IS MORE"], "part87.xhtml", headings=(0, 1), identity="divider"),
                section("The next question", ["The next question", "The first prose paragraph remains."], "part88.xhtml", headings=(0,), identity="body"),
            ], "power-of-now", "The Power of Now", {},
        )
        self.assertEqual(chapters[0]["title"], "A LONG HEADING THERE IS MORE / The next question")
        self.assertEqual(chapters[0]["paragraphs"], ["The first prose paragraph remains."])

    def test_repeated_habit_subtitle_moves_but_note_is_retained(self):
        paragraphs = ["PRINCIPLES OF PERSONAL VISION", "The first substantive paragraph remains.", "A note referring to the original planning diagram remains."]
        chapters, _ = importer.clean_chapters(
            [section("Habit 1 A Demonstration Principles of Personal Vision", paragraphs)],
            "seven-habits", "The 7 Habits of Highly Effective People", {},
        )
        self.assertEqual(chapters[0]["paragraphs"], paragraphs[1:])


class CurrentCorpusChecks(unittest.TestCase):
    @unittest.skipUnless((importer.PROJECT_ROOT / ".local/books").is_dir(), "Private imported books are not installed")
    def test_counts_editions_and_report_match_current_corpus(self):
        root = importer.PROJECT_ROOT
        stats = json.loads((root / "src/data/imported-books.json").read_text(encoding="utf-8"))
        report = json.loads((root / ".local/cleanup-report.json").read_text(encoding="utf-8"))
        self.assertEqual(report["parserVersion"], importer.PARSER_VERSION)
        self.assertEqual({p.stem for p in (root / ".local/books").glob("*.json")}, set(importer.BOOKS))
        for book_id, expected in stats.items():
            with self.subTest(book=book_id):
                content = json.loads((root / ".local/books" / f"{book_id}.json").read_text(encoding="utf-8"))
                paragraphs = [p for c in content["chapters"] for p in c["paragraphs"]]
                counts = {"sections": len(content["chapters"]), "paragraphs": len(paragraphs), "words": sum(len(importer.WORD_RE.findall(p)) for p in paragraphs)}
                self.assertEqual(content["editionId"], expected["editionId"])
                self.assertEqual(counts, {"sections": expected["chapterCount"], "paragraphs": expected["paragraphCount"], "words": expected["wordCount"]})
                self.assertEqual(counts, report["books"][book_id]["after"])
                self.assertFalse(any(a == b for a, b in zip(paragraphs, paragraphs[1:])))
                for chapter in content["chapters"]:
                    self.assertTrue(chapter["title"].strip())
                    self.assertTrue(chapter["paragraphs"])
                    self.assertTrue(all(isinstance(p, str) and p.strip() for p in chapter["paragraphs"]))
                    self.assertFalse(chapter["title"].isdigit())
                    self.assertNotIn("...", chapter["title"])
                    opening = importer.label_key(chapter["paragraphs"][0])
                    title = importer.label_key(chapter["title"])
                    self.assertFalse(len(opening) > 8 and title.endswith(opening))


if __name__ == "__main__":
    unittest.main()
