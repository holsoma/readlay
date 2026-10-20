from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
import math
import struct
from types import SimpleNamespace
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))
from audio.core import SAMPLE_RATE, PreparationError, file_digest, require_encoder
from audio.locations import canonical_cfi, source_words, write_canonical_epub
from audio.word_alignment import ctc_viterbi, spoken_sentence
from audio.word_pipeline import cached_sentence, sentence_chunks
from audio.upload import upload_plan
from generate_audiobook import arguments, generate


class CountingProvider:
    fingerprint = {"engine": "test-tone", "version": "1"}
    calls = 0
    def __init__(self, *_):
        pass
    def pcm_chunks(self, text):
        type(self).calls += 1
        yield b"\0\0" * SAMPLE_RATE


class ExactFixtureAligner:
    """Controlled acoustic output for pipeline tests, never production fallback."""
    fingerprint = {"engine": "explicit-test-fixture", "version": "1"}
    calls = 0
    def __init__(self, *_):
        pass
    def align(self, path, spoken, words):
        type(self).calls += 1
        return [{"charStart": word["charStart"], "charEnd": word["charEnd"],
                 "startSeconds": index / max(len(words), 1), "endSeconds": (index + 0.75) / max(len(words), 1), "confidence": 0.95}
                for index, word in enumerate(words)]


class WordPipelineTests(unittest.TestCase):
    def setUp(self):
        CountingProvider.calls = ExactFixtureAligner.calls = 0

    def test_opus_mobile_default_and_legacy_bitrate_are_separate(self):
        common = ["book.json", "--book-id", "fixture"]
        self.assertEqual(arguments(common).bitrate, "24k")
        self.assertEqual(arguments(common + ["--legacy-paragraph-mp3"]).bitrate, "64k")
        self.assertEqual(arguments(common + ["--bitrate", "32k"]).bitrate, "32k")

    def test_unicode_utf16_ranges_contractions_hyphens_and_numbers(self):
        text = "😀 Don't re‑read café 42 times; 3.14!"
        words = source_words(text)
        self.assertEqual([word["text"] for word in words], ["Don't", "re‑read", "café", "42", "times", "3.14"])
        self.assertEqual(words[0]["charStart"], 3)
        encoded = text.encode("utf-16-le")
        for word in words:
            self.assertEqual(encoded[word["charStart"] * 2:word["charEnd"] * 2].decode("utf-16-le"), word["text"])
        spoken, mapped = spoken_sentence(text)
        self.assertIn("forty two", spoken)
        self.assertIn("Don't", spoken)
        self.assertIn("re read", spoken)
        self.assertEqual([word["charStart"] for word in mapped], [word["charStart"] for word in words])
        spoken, mapped = spoken_sentence("a·tom·ic hab·it")
        self.assertEqual(spoken, "atomic habit")
        self.assertEqual([word["text"] for word in mapped], ["a", "tom", "ic", "hab", "it"])

    def test_numeric_normalisation_preserves_meaning_and_rejects_ambiguity(self):
        from audio.word_alignment import spoken_word
        self.assertEqual(spoken_word("1,000"), "one thousand")
        self.assertEqual(spoken_word("3.14"), "three point one four")
        self.assertEqual(spoken_word("1st"), "first")
        self.assertEqual(spoken_word("21st"), "twenty first")
        self.assertEqual(spoken_word("20-year-old"), "twenty year old")
        self.assertEqual(spoken_word("1930s"), "nineteen thirties")
        self.assertEqual(spoken_word("20-30"), "twenty to thirty")
        spoken, mapped = spoken_sentence("Pay $3.50 for 1,000 items; the 21st is free.")
        self.assertIn("three dollars fifty cents", spoken)
        self.assertIn("one thousand", spoken)
        self.assertEqual([word["text"] for word in mapped], ["Pay", "3.50", "for", "1,000", "items", "the", "21st", "is", "free"])
        for invalid in ("1,00", "3.1.4", "A12B", "11st"):
            with self.assertRaises(PreparationError):
                spoken_word(invalid)
        for text in ("-5 degrees.", "−5 degrees."):
            self.assertTrue(spoken_sentence(text)[0].startswith("minus five"))
        for text in ("-$3.50", "$-3.50", "−£3.50"):
            self.assertTrue(spoken_sentence(text)[0].startswith("minus three"))
        for text in ("1/2 cup.", "½ cup.", "x^2 = 4.", ".5%", "20–30 days"):
            with self.assertRaises(PreparationError):
                spoken_sentence(text)

    def test_silence_and_uniform_acoustic_emissions_fail_closed(self):
        try:
            import numpy as np
            import torch
        except ImportError:
            self.skipTest("Local acoustic dependencies required")
        from audio.word_alignment import Wav2Vec2Aligner
        aligner = Wav2Vec2Aligner.__new__(Wav2Vec2Aligner)
        aligner.np, aligner.torch, aligner.device = np, torch, "cpu"
        aligner.fingerprint = {"minimumRms": .001, "minimumPeak": .005, "minimumWordConfidence": .08,
                               "minimumMeanConfidence": .20, "frameStrideSamples": 320, "acousticSampleRate": 16000}
        aligner.blank = 0
        aligner.vocab = {character: index + 1 for index, character in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ'|")}
        aligner.processor = lambda samples, **_: SimpleNamespace(input_values=torch.tensor(samples).unsqueeze(0))
        aligner.model = lambda _: SimpleNamespace(logits=torch.zeros((1, 50, 32)))
        spoken, mapped = spoken_sentence("Two words.")
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "speech.wav"
            import wave
            for silent in (True, False):
                pcm = b"\0\0" * SAMPLE_RATE if silent else b"".join(struct.pack("<h", int(8000 * math.sin(index * .12))) for index in range(SAMPLE_RATE))
                with wave.open(str(path), "wb") as handle:
                    handle.setnchannels(1)
                    handle.setsampwidth(2)
                    handle.setframerate(SAMPLE_RATE)
                    handle.writeframes(pcm)
                with self.assertRaisesRegex(PreparationError, "speech signal" if silent else "confidence"):
                    aligner.align(path, spoken, mapped)

    def test_cached_word_confidence_cannot_bypass_fresh_alignment_gates(self):
        import hashlib
        from audio.core import canonical_json
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cached_sentence("Every source word.", CountingProvider(), ExactFixtureAligner(), root)
            path = next(root.rglob("*.alignment.json"))
            record = json.loads(path.read_text())
            record["words"][0]["confidence"] = .001
            record["wordsSha256"] = hashlib.sha256(canonical_json(record["words"])).hexdigest()
            path.write_text(json.dumps(record))
            cached_sentence("Every source word.", CountingProvider(), ExactFixtureAligner(), root)
            self.assertEqual(CountingProvider.calls, 1)
            self.assertEqual(ExactFixtureAligner.calls, 2)

    def test_sentence_chunks_preserve_all_words_and_split_long_sentences(self):
        text = "First sentence. " + "A long sentence with repeated words " * 40 + "ends here! Final sentence."
        ranges = sentence_chunks(text, 150)
        self.assertTrue(all(0 < end - start <= 150 for start, end in ranges))
        self.assertEqual([word["text"] for word in source_words(text)],
                         [word["text"] for start, end in ranges for word in source_words(text[start:end])])
        self.assertEqual(text[slice(*ranges[0])], "First sentence.")
        with self.assertRaisesRegex(PreparationError, "unbroken"):
            sentence_chunks("x" * 200, 80)
        hesitation = '“Uh. Um.” I stalled. Ten seconds passed.'
        self.assertEqual(sentence_chunks(hesitation, 350), [(0, len(hesitation))])
        initials = "The author B. F. Example wrote this complete sentence. Another complete sentence has enough context."
        first_start, first_end = sentence_chunks(initials, 350)[0]
        self.assertIn("B. F. Example", initials[first_start:first_end])
        self.assertFalse(any(initials[start:end].endswith(" B.") for start, end in sentence_chunks(initials, 350)))

    def test_real_epub_contains_literal_source_text_and_cfi_spine_order(self):
        book = {"editionId": "exact-v1", "chapters": [{"id": "original", "title": "First", "paragraphs": ["😀 A & B < C.\r\nNext line.", "Second."]}]}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "canonical.epub"
            digest = write_canonical_epub(book, path, "fixture")
            self.assertEqual(digest, write_canonical_epub(book, path, "fixture"))
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(archive.namelist()[0], "mimetype")
                self.assertEqual(archive.getinfo("mimetype").compress_type, zipfile.ZIP_STORED)
                package = ET.fromstring(archive.read("EPUB/package.opf"))
                self.assertEqual([child.tag.split("}")[-1] for child in package], ["metadata", "manifest", "spine"])
                self.assertEqual(package[2][0].attrib["id"], "chapter-1")
                ids = [element.attrib["id"] for element in package.iter() if "id" in element.attrib]
                self.assertEqual(len(ids), len(set(ids)))
                manifest_ids = {element.attrib["id"] for element in package[1]}
                self.assertTrue(all(element.attrib["idref"] in manifest_ids for element in package[2]))
                document = ET.fromstring(archive.read("EPUB/chapter-1.xhtml"))
                body = document[1]
                self.assertEqual([p.text for p in body], book["chapters"][0]["paragraphs"])
                self.assertTrue(all(len(p) == 0 for p in body))
                self.assertEqual(canonical_cfi(0, 1, 3), "epubcfi(/6/2[chapter-1]!/4/4/1:3)")

    def test_ctc_uses_actual_emission_peaks_and_handles_repeated_letters(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy is a local audio dependency")
        # Blank=0, A=1, B=2. Unequal durations and an explicit repeated A blank
        # make proportional timestamp assignment fail these expectations.
        labels = [0, 1, 1, 0, 1, 0, 2, 2, 2, 0]
        probabilities = np.full((len(labels), 3), -12.0)
        for frame, label in enumerate(labels):
            probabilities[frame, label] = -0.01
        spans = ctc_viterbi(probabilities, [1, 1, 2], 0)
        self.assertEqual([(start, end) for start, end, _ in spans], [(1, 3), (4, 5), (6, 9)])
        with self.assertRaisesRegex(PreparationError, "too short"):
            ctc_viterbi(probabilities[:2], [1, 1, 1], 0)

    def test_verified_sentence_audio_and_alignment_are_reused_independently(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = cached_sentence("One clear sentence.", CountingProvider(), ExactFixtureAligner(), root)
            cached_sentence("One clear sentence.", CountingProvider(), ExactFixtureAligner(), root)
            self.assertEqual((CountingProvider.calls, ExactFixtureAligner.calls), (1, 1))
            class NewAligner(ExactFixtureAligner):
                fingerprint = {"engine": "explicit-test-fixture", "version": "2"}
            cached_sentence("One clear sentence.", CountingProvider(), NewAligner(), root)
            self.assertEqual(CountingProvider.calls, 1, "Changing alignment must not regenerate verified narration")
            self.assertEqual(first[1], SAMPLE_RATE)

    def test_alignment_missing_source_word_fails_closed(self):
        class BrokenAligner(ExactFixtureAligner):
            def align(self, *_):
                return []
        with tempfile.TemporaryDirectory() as temp, self.assertRaisesRegex(PreparationError, "every exact source word"):
            cached_sentence("Every word matters.", CountingProvider(), BrokenAligner(), Path(temp))

    def test_opus_generation_resume_exact_word_cfis_and_upload_validation(self):
        try:
            require_encoder()
        except PreparationError:
            self.skipTest("FFmpeg and ffprobe required")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            book = {"editionId": "v2", "chapters": [{"id": "a", "title": "First", "paragraphs": ["😀 Don't re-read 42 words. A second sentence.", "Final paragraph."]}, {"id": "b", "title": "Next", "paragraphs": ["Another chapter."]}]}
            source = root / "book.json"
            source.write_text(json.dumps(book), encoding="utf-8")
            common = [str(source), "--book-id", "fixture", "--rights-confirmed", "--output-root", str(root / "audio"), "--cache-root", str(root / "cache")]
            with contextlib.redirect_stdout(io.StringIO()):
                path = generate(arguments(common + ["--chapters", "1"]), CountingProvider, ExactFixtureAligner)
                original = json.loads(path.read_text())
                chapter_file = root / "audio" / original["chapters"][0]["audioPath"]
                stamp = chapter_file.stat().st_mtime_ns
                calls = CountingProvider.calls, ExactFixtureAligner.calls
                path = generate(arguments(common + ["--chapters", "1"]), CountingProvider, ExactFixtureAligner)
                self.assertEqual(calls, (CountingProvider.calls, ExactFixtureAligner.calls))
                self.assertEqual(stamp, chapter_file.stat().st_mtime_ns, "Verified Opus must never be re-encoded")
                path = generate(arguments(common + ["--chapters", "2"]), CountingProvider, ExactFixtureAligner)
            manifest, plan, _ = upload_plan(path, root / "audio")
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertTrue(manifest["coverage"]["complete"])
            self.assertEqual(len(plan), 2)
            self.assertEqual(manifest["chapters"][0]["words"][0]["charStart"], 3)
            self.assertGreater(manifest["chapters"][0]["words"][2]["startSeconds"], 0)
            self.assertEqual(manifest["chapters"][0]["byteLength"], chapter_file.stat().st_size)
            self.assertLess(abs(manifest["chapters"][0]["durationSeconds"] - manifest["chapters"][0]["encodedDurationSeconds"]), 0.05)
            manifest["chapters"][0]["words"][0]["cfi"] = "epubcfi(/6/2!/4/2/1:0)"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(PreparationError, "CFI"):
                upload_plan(path, root / "audio")


if __name__ == "__main__":
    unittest.main()
