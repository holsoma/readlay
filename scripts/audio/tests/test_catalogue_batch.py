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

from audio.core import PreparationError, atomic_json, read_book, require_encoder
from generate_audiobook_catalogue import ROOT, WarmEngines, arguments, ensure_staging_root, run_batch
from test_word_pipeline import CountingProvider, ExactFixtureAligner


class CatalogueBatchTests(unittest.TestCase):
    def source(self, root: Path, book_id: str, count: int = 2) -> Path:
        path = root / "books" / (book_id + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(path, {"editionId": "v1", "chapters": [{"id": f"chapter-{index + 1}", "title": f"Chapter {index + 1}",
                    "paragraphs": ["These original fixture words are private."]} for index in range(count)]})
        return path

    def settings(self, root: Path, *options: str):
        return arguments(["--books-dir", str(root / "books"), "--output-root", str(root / "stage"),
                          "--cache-root", str(root / "cache"), "--rights-confirmed", *options])

    @staticmethod
    def fake_generation(args, provider, aligner):
        provider(args.voice, args.voice[0], args.model_revision, args.allow_download, args.device)
        aligner(args.allow_download, args.device)
        chapter_index = int(args.chapters) - 1
        path = args.output_root / args.book_id / "v1" / f"kokoro-{args.voice}" / "manifest.json"
        manifest = json.loads(path.read_text()) if path.exists() else {"generationId": "fixture-generation", "chapters": []}
        manifest["chapters"] = [item for item in manifest["chapters"] if item["chapterIndex"] != chapter_index]
        manifest["chapters"].append({"chapterIndex": chapter_index, "byteLength": 12, "durationSeconds": 1.25,
                                      "words": [{"charStart": 0, "charEnd": 5}]})
        atomic_json(path, manifest)
        return path

    def test_explicit_rights_are_required_and_dry_run_loads_no_models_or_outputs(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            arguments([])
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            self.source(root, "fixture")
            def forbidden(*_):
                raise AssertionError("Dry run must not load models or generate speech")
            self.assertEqual(run_batch(self.settings(root, "--dry-run"), forbidden, forbidden, forbidden), 0)
            self.assertFalse((root / "stage").exists())

    def test_round_robin_chapters_warm_two_providers_one_aligner_and_resume_verifies_all(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            self.source(root, "alpha")
            self.source(root, "beta", 1)
            providers, aligners, attempts = [], [], []
            def provider(*settings):
                providers.append(settings)
                return object()
            def aligner(*settings):
                aligners.append(settings)
                return object()
            def generate(args, provider, aligner):
                attempts.append((args.book_id, args.voice, args.chapters))
                return self.fake_generation(args, provider, aligner)
            self.assertEqual(run_batch(self.settings(root), generate, provider, aligner), 0)
            self.assertEqual(attempts[:4], [("alpha", "af_heart", "1"), ("alpha", "am_michael", "1"),
                                            ("beta", "af_heart", "1"), ("beta", "am_michael", "1")])
            self.assertEqual(len(providers), 2)
            self.assertEqual(len(aligners), 1)
            report = json.loads((root / "stage" / "batch-progress.json").read_text())
            self.assertEqual((report["status"], report["counts"]["succeeded"]), ("completed", 6))
            self.assertEqual([item["gender"] for item in report["voices"]], ["female", "male"])
            self.assertEqual(run_batch(self.settings(root), generate, provider, aligner), 0)
            self.assertEqual(len(attempts), 12, "Resuming must verify chapters through generation, not trust old report flags")
            report = json.loads((root / "stage" / "batch-progress.json").read_text())
            self.assertTrue(all(item["attempts"] == 2 for item in report["results"].values()))

    def test_independent_failures_continue_and_source_context_never_reaches_console(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.source(root, "fixture")
            attempted = []
            def generate(args, provider, aligner):
                attempted.append((args.voice, args.chapters))
                if args.voice == "af_heart" and args.chapters == "1":
                    print("PRIVATE SOURCE ONLY IN LOG")
                    raise PreparationError("Chapter 1, paragraph 1, sentence chunk 1: PRIVATE EXCEPTION")
                return self.fake_generation(args, provider, aligner)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = run_batch(self.settings(root), generate, lambda *_: object(), lambda *_: object())
            self.assertEqual(code, 1)
            self.assertEqual(len(attempted), 4)
            self.assertNotIn("PRIVATE SOURCE", output.getvalue())
            self.assertNotIn("PRIVATE EXCEPTION", output.getvalue())
            self.assertNotIn("original fixture", output.getvalue())
            report = json.loads((root / "stage" / "batch-progress.json").read_text())
            self.assertEqual(report["counts"]["failed"], 1)
            self.assertEqual(report["counts"]["succeeded"], 3)
            result = next(item for item in report["results"].values() if item["status"] == "failed")
            details = json.loads(Path(result["errorReportPath"]).read_text())
            self.assertEqual(details["sourceSentence"], "These original fixture words are private.")
            self.assertIn("PRIVATE EXCEPTION", details["message"])
            self.assertIn("PRIVATE SOURCE", Path(result["logPath"]).read_text())

    def test_ctrl_c_checkpoints_attempt_and_retains_completed_output(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            self.source(root, "fixture", 1)
            def interrupted(args, provider, aligner):
                if args.voice == "am_michael":
                    raise KeyboardInterrupt
                return self.fake_generation(args, provider, aligner)
            self.assertEqual(run_batch(self.settings(root), interrupted, lambda *_: object(), lambda *_: object()), 130)
            report = json.loads((root / "stage" / "batch-progress.json").read_text())
            self.assertEqual(report["status"], "interrupted")
            self.assertEqual((report["counts"]["succeeded"], report["counts"]["interrupted"]), (1, 1))
            completed = next(item for item in report["results"].values() if item["status"] == "succeeded")
            self.assertTrue(Path(completed["manifestPath"]).is_file())
            self.assertEqual(run_batch(self.settings(root), self.fake_generation, lambda *_: object(), lambda *_: object()), 0)

    def test_published_audio_tree_is_rejected_without_changing_manifest_or_receipt(self):
        with self.assertRaisesRegex(PreparationError, "active audiobook"):
            ensure_staging_root(ROOT / ".local" / "audiobooks")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            active = root / "stage" / "fixture" / "v1" / "kokoro-af_heart"
            active.mkdir(parents=True)
            for name in ("manifest.json", "published.json"):
                (active / name).write_text("unchanged", encoding="utf-8")
            self.source(root, "fixture", 1)
            with self.assertRaisesRegex(PreparationError, "published receipt"):
                run_batch(self.settings(root), self.fake_generation)
            for name in ("manifest.json", "published.json"):
                self.assertEqual((active / name).read_text(), "unchanged")
            self.assertFalse((root / "stage" / "batch-progress.json").exists())

    def test_source_change_during_batch_stops_affected_book_without_mixing_editions(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            source = self.source(root, "fixture", 1)
            def change_source(args, provider, aligner):
                result = self.fake_generation(args, provider, aligner)
                book = read_book(source)
                book["chapters"][0]["paragraphs"][0] += " Changed."
                atomic_json(source, book)
                return result
            self.assertEqual(run_batch(self.settings(root), change_source, lambda *_: object(), lambda *_: object()), 1)
            report = json.loads((root / "stage" / "batch-progress.json").read_text())
            self.assertEqual((report["counts"]["succeeded"], report["counts"]["failed"]), (1, 1))

    def test_failed_engine_setup_is_not_retried_for_every_chapter(self):
        attempted = []
        def broken(*settings):
            attempted.append(settings)
            raise PreparationError("Fixture model unavailable")
        engines = WarmEngines(broken)
        for _ in range(2):
            with self.assertRaises(PreparationError):
                engines.provider("af_heart", "a", "main", False, "cpu")
        self.assertEqual(len(attempted), 1)

    def test_real_pipeline_stages_and_reuses_opus_with_warmed_fixture_engines(self):
        try:
            require_encoder()
        except PreparationError:
            self.skipTest("FFmpeg and ffprobe required")
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            self.source(root, "fixture", 1)
            providers, aligners = [], []
            def provider(*settings):
                providers.append(settings[0])
                return CountingProvider(*settings)
            def aligner(*settings):
                aligners.append(settings)
                return ExactFixtureAligner(*settings)
            self.assertEqual(run_batch(self.settings(root), provider_factory=provider, aligner_factory=aligner), 0)
            self.assertEqual(providers, ["af_heart", "am_michael"])
            self.assertEqual(len(aligners), 1)
            files = {str(path): (path.stat().st_mtime_ns, path.read_bytes()) for path in (root / "stage").rglob("*.opus")}
            self.assertEqual(len(files), 2)
            self.assertEqual(run_batch(self.settings(root), provider_factory=provider, aligner_factory=aligner), 0)
            self.assertEqual(files, {str(path): (path.stat().st_mtime_ns, path.read_bytes()) for path in (root / "stage").rglob("*.opus")})


if __name__ == "__main__":
    unittest.main()
