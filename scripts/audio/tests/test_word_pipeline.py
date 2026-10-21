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
        for text in ("conflicting^ signals", "x∫2", "0.99365 = 00.03", "1.01365 = 37.78"):
            with self.assertRaises(PreparationError):
                spoken_sentence(text)

    def test_spoken_ranges_fractions_and_operators_retain_every_exact_source_word(self):
        examples = {
            "😀 Use 1/2 cup and ½ cup, or 1½ cups.": ("one over two", "one half", "one and one half"),
            "Wait 20–30 days, then check 1985—1986.": ("twenty to thirty", "one thousand nine hundred and eighty five to one thousand nine hundred and eighty six"),
            "x^2 = 4; 6 × 2 > 10; 8 ÷ 2 < 5; √9 ± 1.": ("x to the power of two", "equals four", "six  times  two  greater than  ten", "square root of nine"),
            ".05% and -.5 degrees.": ("zero point zero five", "minus zero point five"),
            "Pay $.50 or -£.25.": ("zero dollars fifty cents", "minus zero pounds sterling twenty five pence"),
            "The 20/20/20 Formula.": ("twenty slash twenty slash twenty",),
            "Wake up > Make my bed > Take a shower.": ("Wake up then Make my bed then Take a shower",),
            "PRESSURE × REFUELING = GROWTH + ENDURANCE.": ("PRESSURE times REFUELING equals GROWTH plus ENDURANCE",),
            "X > Y.": ("X greater than Y",),
            "0.99^365 = 00.03 and 1.01^365 = 37.78.": ("zero point nine nine to the power of three hundred and sixty five", "equals zero point zero three", "one point zero one to the power of three hundred and sixty five"),
        }
        for text, expected_parts in examples.items():
            with self.subTest(text=text):
                spoken, mapped = spoken_sentence(text)
                for part in expected_parts:
                    self.assertIn(" ".join(part.split()), " ".join(spoken.split()))
                self.assertEqual([{key: word[key] for key in ("text", "start", "end", "charStart", "charEnd")} for word in mapped], source_words(text))
                for word in mapped:
                    self.assertTrue(spoken[word["spokenStart"]:word["spokenEnd"]].strip())
                    self.assertEqual(text[word["start"]:word["end"]], word["text"])
        for text in ("1/0 cup", "2²", "1.01365=37.78", "wrong^ spelling", "a^d"):
            with self.subTest(rejected=text), self.assertRaises(PreparationError):
                spoken_sentence(text)

    def test_known_written_labels_and_case_insensitive_decades_are_not_guessed_ocr(self):
        from audio.word_alignment import spoken_word
        expected = {"1940S": "nineteen forties", "1990S": "nineteen nineties", "60’s": "sixties", "600s": "six hundreds",
                    "F1": "F one", "Q1": "Q one", "Q4": "Q four", "5K": "five K", "5AC": "five A C",
                    "2WW": "two W W", "2MP": "two M P", "2x3x": "two times three times", "10x": "ten times",
                    "x100": "times one hundred", "18ff": "eighteen F F", "142n": "one hundred and forty two N", "A380": "A three eight zero",
                    "NY2011": "N Y two zero one one", "eaao5961": "E A A O five nine six one"}
        for text, result in expected.items():
            with self.subTest(text=text):
                self.assertEqual(spoken_word(text), result)
        for text in ("i982", "8o", "60o", "1oo", "0fevery", "A12B", "Q5", "PANCHA1"):
            with self.subTest(rejected=text), self.assertRaises(PreparationError):
                spoken_word(text)

    def test_url_and_doi_identifiers_speak_digits_with_exact_original_ranges(self):
        text = "😀 See https://example.com/a12-b3?q=9 and doi:10.1093/sleep/29.11.1398."
        spoken, mapped = spoken_sentence(text)
        self.assertIn("H T T P S", spoken)
        self.assertIn("A one two dash B three", spoken)
        self.assertIn("question mark", spoken)
        self.assertIn("two nine dot one one dot one three nine eight", spoken)
        self.assertEqual([{key: word[key] for key in ("text", "start", "end", "charStart", "charEnd")} for word in mapped], source_words(text))
        self.assertEqual(mapped[0]["charStart"], 3)
        encoded = text.encode("utf-16-le")
        for word in mapped:
            self.assertEqual(encoded[word["charStart"] * 2:word["charEnd"] * 2].decode("utf-16-le"), word["text"])
            self.assertTrue(spoken[word["spokenStart"]:word["spokenEnd"]].strip())
        with self.assertRaises(PreparationError):
            spoken_sentence("An unlabelled numeric value 3.1.4 needs review.")
        broken_identifiers = "See @mmay3r, disciplined/comments/6fgqbv, and doi:10.1016/j.cel rep.2014.08.037."
        spoken, mapped = spoken_sentence(broken_identifiers)
        self.assertIn("M M A Y three R", spoken)
        self.assertIn("six F G Q B V", spoken)
        self.assertIn("two zero one four dot zero eight dot zero three seven", spoken)
        self.assertEqual([word["text"] for word in mapped], [word["text"] for word in source_words(broken_identifiers)])
        slug = "https://example.com/21722163-experimental-iterative-data-driven-approach"
        spoken, mapped = spoken_sentence(slug)
        self.assertIn("two one seven two two one six three dash experimental dash iterative dash data dash driven dash approach", spoken)
        self.assertEqual([word["text"] for word in mapped], [word["text"] for word in source_words(slug)])

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
