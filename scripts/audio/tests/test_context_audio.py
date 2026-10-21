from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from audio.core import SAMPLE_RATE, PreparationError
from audio.locations import corrected_source, source_words, utf16_offset
from audio.word_alignment import AcousticAlignmentError
from audio.word_pipeline import CONTEXT_SOURCE_CHARS, cached_context_sentence, recover_sentence, source_context


class ContextAudioTests(unittest.TestCase):
    def recording(self, directory):
        text = "😀 Before target words. After."
        start, end = text.index("target"), text.index(" After")
        timings = ((.1, .3), (.55, .8), (1.2, 1.35), (1.6, 1.9))
        words = [{"charStart": word["charStart"], "charEnd": word["charEnd"], "startSeconds": a, "endSeconds": b, "confidence": .95}
                 for word, (a, b) in zip(source_words(text), timings)]
        frames = SAMPLE_RATE * 2
        data = b"".join(struct.pack("<h", index % 30000) for index in range(frames))
        path = directory / "full.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            handle.writeframes(data)
        return text, start, end, path, frames, words, data

    def test_real_pcm_is_cut_at_measured_neighbour_cues_and_exact_target_times_rebased(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            text, start, end, full, frames, words, data = self.recording(root)
            aligner = SimpleNamespace(fingerprint={"engine": "measured-test"})
            with patch("audio.word_pipeline.cached_sentence", return_value=(full, frames, words)):
                path, count, target = cached_context_sentence(text[start:end], text, [], start, end, None, aligner, root)
                stamp = path.stat().st_mtime_ns
                again = cached_context_sentence(text[start:end], text, [], start, end, None, aligner, root)
            self.assertEqual(count, round(1.3 * SAMPLE_RATE))
            with wave.open(str(path), "rb") as handle:
                self.assertEqual(handle.readframes(count), data[round(.3 * SAMPLE_RATE) * 2:round(1.6 * SAMPLE_RATE) * 2])
            self.assertAlmostEqual(target[0]["startSeconds"], .25)
            self.assertAlmostEqual(target[0]["endSeconds"], .5)
            self.assertAlmostEqual(target[1]["startSeconds"], .9)
            self.assertEqual([(word["charStart"], word["charEnd"]) for word in target], [(0, 6), (7, 12)])
            self.assertEqual([word["confidence"] for word in target], [.95, .95])
            self.assertEqual(again, (path, count, target))
            self.assertEqual(path.stat().st_mtime_ns, stamp, "A verified context clip is reused byte for byte")

    def test_missing_or_low_confidence_candidate_words_never_produce_a_clip(self):
        for bad in ("missing", "low-confidence"):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                text, start, end, full, frames, words, _ = self.recording(root)
                if bad == "missing":
                    words.pop(1)
                else:
                    words[1]["confidence"] = .01
                with patch("audio.word_pipeline.cached_sentence", return_value=(full, frames, words)), self.assertRaises(AcousticAlignmentError):
                    cached_context_sentence(text[start:end], text, [], start, end, None, SimpleNamespace(fingerprint={}), root)
                self.assertFalse((root / "contextual").exists())

    def test_context_is_bounded_on_complete_words_and_repairs_keep_utf16_offsets(self):
        first = "A source sentence with several ordinary words. " * 8 + "😀 widi"
        target = "subdecongenial"
        chapter = {"paragraphs": [first, target, "A following source sentence with several ordinary words. " * 8]}
        sw = source_words(first)[-1]
        corrections = {(0, 0): [{"charStart": sw["charStart"], "charEnd": sw["charEnd"], "sourceText": "widi", "replacementText": "with"}],
                       (0, 1): [{"charStart": 0, "charEnd": len(target), "sourceText": target, "replacementText": "subtle, congenial"}]}
        context, changes, start, end = source_context(chapter, 0, 1, 0, len(target), corrections)
        self.assertEqual(context[start:end], target)
        self.assertLessEqual(start, CONTEXT_SOURCE_CHARS + 1)
        self.assertLessEqual(len(context) - end, CONTEXT_SOURCE_CHARS + 1)
        display, mapped = corrected_source(context, changes)
        self.assertIn("😀 with subtle, congenial", display)
        self.assertEqual([word["text"] for word in mapped], [word["text"] for word in source_words(context)])
        target_change = next(change for change in changes if change["sourceText"] == target)
        self.assertEqual(target_change["charStart"], utf16_offset(context, start))

    def test_only_acoustic_errors_trigger_context_recovery(self):
        chapter = {"paragraphs": ["Before.", "Target.", "After."]}
        marker = (Path("fixture.wav"), 42, [])
        with patch("audio.word_pipeline.cached_sentence", side_effect=AcousticAlignmentError("confidence")), \
             patch("audio.word_pipeline.cached_context_sentence", return_value=marker) as recovery:
            self.assertEqual(recover_sentence(chapter, 0, 1, 0, 7, {}, None, None, Path("cache")), marker)
            recovery.assert_called_once()
        with patch("audio.word_pipeline.cached_sentence", side_effect=PreparationError("Unsupported source")), \
             patch("audio.word_pipeline.cached_context_sentence") as recovery, self.assertRaisesRegex(PreparationError, "Unsupported source"):
            recover_sentence(chapter, 0, 1, 0, 7, {}, None, None, Path("cache"))
        recovery.assert_not_called()

    def test_unavailable_neighbours_and_mismatched_recipes_fail_closed(self):
        with self.assertRaises(AcousticAlignmentError):
            source_context({"paragraphs": ["Only."]}, 0, 0, 0, 5, {})
        with self.assertRaisesRegex(PreparationError, "differs"), patch("audio.word_pipeline.cached_sentence") as narration:
            cached_context_sentence("Changed", "Original", [], 0, 8, None, None, Path("cache"))
        narration.assert_not_called()


if __name__ == "__main__":
    unittest.main()
