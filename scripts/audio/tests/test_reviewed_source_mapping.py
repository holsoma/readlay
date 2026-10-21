from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))

from audio.core import PreparationError, require_encoder
from audio.locations import canonical_cfi, corrected_source, load_reader_corrections, reviewed_corrections, sentence_corrections, source_words
from audio.word_pipeline import cached_sentence, sentence_chunks, spoken_source_sentence
from generate_audiobook import arguments, generate
from test_word_pipeline import CountingProvider, ExactFixtureAligner


class ReviewedSourceMappingTests(unittest.TestCase):
    def setUp(self):
        CountingProvider.calls = ExactFixtureAligner.calls = 0

    @staticmethod
    def change(text: str, word: str, replacement: str) -> dict:
        original = next(item for item in source_words(text) if item["text"] == word)
        return {key: original[key] for key in ("charStart", "charEnd")} | {"sourceText": word, "replacementText": replacement}

    def test_spoken_repairs_retain_original_utf16_ranges_and_one_cue_per_token(self):
        text = "😀 We need subdecongenial words uswhen reading 42 times."
        corrections = [self.change(text, "subdecongenial", "subtle, congenial"), self.change(text, "uswhen", "us; when")]
        display, original = corrected_source(text, corrections)
        self.assertEqual(display, "😀 We need subtle, congenial words us; when reading 42 times.")
        spoken, mapped = spoken_source_sentence(text, corrections)
        self.assertEqual([item["text"] for item in mapped], [item["text"] for item in source_words(text)])
        self.assertEqual(mapped[0]["charStart"], 3)
        for expected, actual in zip(source_words(text), mapped):
            self.assertEqual((actual["charStart"], actual["charEnd"]), (expected["charStart"], expected["charEnd"]))
        self.assertEqual(spoken[mapped[2]["spokenStart"]:mapped[2]["spokenEnd"]], "subtle, congenial")
        self.assertEqual(spoken[mapped[4]["spokenStart"]:mapped[4]["spokenEnd"]], "us; when")
        number = next(item for item in mapped if item["text"] == "42")
        self.assertEqual(spoken[number["spokenStart"]:number["spokenEnd"]], "forty two")
        self.assertEqual(len(original), len(mapped))

    def test_sentence_translation_keeps_later_offsets_and_rejects_partial_tokens(self):
        text = "First sentence has enough useful context for the test. 😀 Next uswhen reading another detailed sentence for context."
        change = self.change(text, "uswhen", "us; when")
        start, end = sentence_chunks(text, 100)[1]
        local = sentence_corrections(text, start, end, [change])
        spoken, mapped = spoken_source_sentence(text[start:end], local)
        changed = next(item for item in mapped if item["text"] == "uswhen")
        self.assertEqual(spoken[changed["spokenStart"]:changed["spokenEnd"]], "us; when")
        self.assertEqual(sentence_corrections(text, 0, start, [change]), [])
        word = next(item for item in source_words(text) if item["text"] == "uswhen")
        with self.assertRaisesRegex(PreparationError, "truncates"):
            sentence_corrections(text, word["start"] + 1, end, [change])

    def test_invalid_or_stale_corrections_fail_before_narration(self):
        text = "😀 Some subdecongenial text."
        valid = self.change(text, "subdecongenial", "subtle, congenial")
        for changes in ([{**valid, "sourceText": "wrong"}], [{**valid, "charStart": valid["charStart"] + 1}],
                        [{**valid, "replacementText": "<script>"}], [{**valid, "replacementText": ""}],
                        [{**valid, "replacementText": "broken\ud800"}],
                        [{**valid, "replacementText": "one two three four five six seven"}], [valid, valid]):
            with self.subTest(changes=changes), self.assertRaises(PreparationError):
                reviewed_corrections(text, changes)

    def test_manifest_is_edition_bound_and_ignores_unrelated_reader_presentation(self):
        text = "Use subdecongenial words."
        book = {"editionId": "v1", "chapters": [{"id": "one", "title": "One", "paragraphs": [text]}]}
        metadata = {"version": 1, "bookId": "fixture", "editionId": "v1", "chapters": [{"title": "Visual title", "images": [], "paragraphs": {"0": {"kind": "quote", "corrections": [self.change(text, "subdecongenial", "subtle, congenial")]}}}]}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "reader.json"
            path.write_text(json.dumps(metadata), encoding="utf-8")
            changes = load_reader_corrections(book, "fixture", path)
            metadata["chapters"][0]["title"] = "A different visual title"
            metadata["chapters"][0]["images"] = [{"alt": "A new image"}]
            path.write_text(json.dumps(metadata), encoding="utf-8")
            self.assertEqual(changes, load_reader_corrections(book, "fixture", path))
            metadata["editionId"] = "stale"
            path.write_text(json.dumps(metadata), encoding="utf-8")
            with self.assertRaisesRegex(PreparationError, "does not match"):
                load_reader_corrections(book, "fixture", path)

    def test_correction_digest_separates_sentence_recordings_and_reuses_identical_mapping(self):
        text = "Use subdecongenial words."
        changes = [self.change(text, "subdecongenial", "subtle, congenial")]
        class RecordingAligner(ExactFixtureAligner):
            seen = []
            def align(self, path, spoken, mapped):
                self.seen.append((spoken, mapped))
                return super().align(path, spoken, mapped)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = cached_sentence(text, CountingProvider(), ExactFixtureAligner(), root)
            repaired = cached_sentence(text, CountingProvider(), RecordingAligner(), root, changes)
            cached_sentence(text, CountingProvider(), RecordingAligner(), root, changes)
            self.assertEqual(CountingProvider.calls, 2)
            self.assertNotEqual(original[0], repaired[0])
            self.assertEqual(len(repaired[2]), len(source_words(text)))
            self.assertIn("subtle, congenial", RecordingAligner.seen[0][0])
            # This mapping differs even though its final spoken letters match.
            changed_punctuation = [self.change(text, "subdecongenial", "subtle, congenial\t")]
            separate = cached_sentence(text, CountingProvider(), ExactFixtureAligner(), root, changed_punctuation)
            self.assertNotEqual(separate[0], repaired[0])

    def test_generation_keeps_legacy_key_without_repairs_then_records_reviewed_mapping(self):
        try:
            require_encoder()
        except PreparationError:
            self.skipTest("FFmpeg and ffprobe required")
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            (root / "books").mkdir()
            (root / "reader").mkdir()
            text = "Use subdecongenial words."
            book = {"editionId": "v1", "chapters": [{"id": "one", "title": "One", "paragraphs": [text]}]}
            source = root / "books" / "fixture.json"
            source.write_text(json.dumps(book), encoding="utf-8")
            common = [str(source), "--book-id", "fixture", "--rights-confirmed", "--output-root", str(root / "audio"), "--cache-root", str(root / "cache")]
            manifest_path = generate(arguments(common), CountingProvider, ExactFixtureAligner)
            baseline = json.loads(manifest_path.read_text())
            self.assertEqual(baseline["narrator"]["gender"], "female")
            metadata = {"version": 1, "bookId": "fixture", "editionId": "v1", "chapters": [{"title": "Visual title", "paragraphs": {"0": {"kind": "quote", "corrections": []}}}]}
            presentation = root / "reader" / "fixture.json"
            presentation.write_text(json.dumps(metadata), encoding="utf-8")
            manifest_path = generate(arguments(common), CountingProvider, ExactFixtureAligner)
            unchanged = json.loads(manifest_path.read_text())
            self.assertEqual(baseline["generationId"], unchanged["generationId"])
            self.assertEqual(CountingProvider.calls, 1)
            metadata["chapters"][0]["paragraphs"]["0"]["corrections"] = [self.change(text, "subdecongenial", "subtle, congenial")]
            presentation.write_text(json.dumps(metadata), encoding="utf-8")
            manifest_path = generate(arguments(common), CountingProvider, ExactFixtureAligner)
            repaired = json.loads(manifest_path.read_text())
            self.assertNotEqual(baseline["generationId"], repaired["generationId"])
            self.assertEqual(baseline["canonicalEpub"]["sha256"], repaired["canonicalEpub"]["sha256"])
            self.assertEqual(source.read_text(), json.dumps(book))
            self.assertEqual([word["charStart"] for word in repaired["chapters"][0]["words"]], [word["charStart"] for word in source_words(text)])
            for word in repaired["chapters"][0]["words"]:
                self.assertEqual(word["cfi"], canonical_cfi(0, 0, word["charStart"]))
            preparation_path = manifest_path.parent / repaired["generationId"] / "preparation.json"
            configuration = json.loads(preparation_path.read_text())["configuration"]
            self.assertEqual(configuration["sourceMapping"]["correctionCount"], 1)
            metadata["chapters"][0]["title"] = "Another visual heading"
            presentation.write_text(json.dumps(metadata), encoding="utf-8")
            manifest_path = generate(arguments(common), CountingProvider, ExactFixtureAligner)
            self.assertEqual(json.loads(manifest_path.read_text())["generationId"], repaired["generationId"])
            self.assertEqual(CountingProvider.calls, 2)
            male_path = generate(arguments(common + ["--voice", "am_michael"]), CountingProvider, ExactFixtureAligner)
            male = json.loads(male_path.read_text())
            self.assertEqual((male["narrator"]["voice"], male["narrator"]["gender"]), ("am_michael", "male"))


if __name__ == "__main__":
    unittest.main()
