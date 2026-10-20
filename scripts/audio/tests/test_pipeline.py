from __future__ import annotations

import contextlib
import hashlib
import io
import json
import math
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))

from audio.core import SAMPLE_RATE, PreparationError, cache_paragraph, canonical_json, child_path, digest_text, encode_chapter, read_book, require_encoder, select_chapters, split_paragraph
from audio.upload import SupabaseStorage, upload_plan
from generate_audiobook import arguments, generate
import upload_audiobook

FIXTURE = Path(__file__).parent / "fixtures" / "original-book.json"


class TestProvider:
    fingerprint = {"engine": "test-only", "version": "1"}

    def __init__(self, *args):
        self.calls = 0

    def pcm_chunks(self, text):
        self.calls += 1
        frames = SAMPLE_RATE // 10
        yield b"".join(struct.pack("<h", round(1000 * math.sin(index * 0.1))) for index in range(frames))


class PipelineTests(unittest.TestCase):
    def test_long_paragraph_preserves_every_non_whitespace_character(self):
        original = "One sentence. " * 130 + "abcdef" * 150 + " Final words."
        chunks = split_paragraph(original, 350)
        self.assertTrue(all(0 < len(chunk) <= 350 for chunk in chunks))
        self.assertEqual("".join("".join(chunks).split()), "".join(original.split()))

    def test_chapter_selection_is_one_based_and_strict(self):
        self.assertEqual(select_chapters("1,3-5,3", 5), [0, 2, 3, 4])
        for selection in ("0", "-1", "6", "3-2", "1-2-3", ""):
            if selection:
                with self.assertRaises(PreparationError):
                    select_chapters(selection, 5)

    def test_source_rejects_empty_paragraphs_and_duplicate_chapter_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "book.json"
            for chapters in ([{"id": "a", "title": "A", "paragraphs": [" "]}], [{"id": "a", "title": "A", "paragraphs": ["A"]}] * 2):
                path.write_text(json.dumps({"editionId": "v1", "chapters": chapters}), encoding="utf-8")
                with self.assertRaises(PreparationError):
                    read_book(path)

    def test_dry_run_needs_no_rights_dependencies_network_or_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "output"
            cache = Path(temp) / "cache"
            args = arguments([str(FIXTURE), "--book-id", "fixture", "--output-root", str(output), "--cache-root", str(cache), "--dry-run"])
            with contextlib.redirect_stdout(io.StringIO()), patch("socket.socket", side_effect=AssertionError("network")):
                self.assertIsNone(generate(args, provider_factory=lambda *_: self.fail("provider loaded")))
            self.assertFalse(output.exists())
            self.assertFalse(cache.exists())

    def test_rights_are_required_before_provider_is_loaded(self):
        args = arguments([str(FIXTURE), "--book-id", "fixture"])
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(PreparationError, "permission"):
            generate(args, provider_factory=lambda *_: self.fail("provider loaded"))

    def test_pcm_cache_is_reused_and_corruption_is_regenerated(self):
        with tempfile.TemporaryDirectory() as temp:
            provider = TestProvider()
            first, frames = cache_paragraph("An original paragraph.", provider, Path(temp), 350)
            self.assertEqual(frames, SAMPLE_RATE // 10)
            cache_paragraph("An original paragraph.", provider, Path(temp), 350)
            self.assertEqual(provider.calls, 1)
            with first.open("r+b") as audio:
                audio.seek(48)
                audio.write(b"broken")
            cache_paragraph("An original paragraph.", provider, Path(temp), 350)
            self.assertEqual(provider.calls, 2)
            cache_paragraph("An original paragraph. ", provider, Path(temp), 350)
            self.assertEqual(provider.calls, 3, "Exact original text changes must change its cache key")

    def test_punctuation_separator_gets_a_real_timeline_without_tts(self):
        with tempfile.TemporaryDirectory() as temp:
            provider = TestProvider()
            _, frames = cache_paragraph("***", provider, Path(temp), 350)
            self.assertEqual(frames, SAMPLE_RATE // 4)
            self.assertEqual(provider.calls, 0)

    def test_paths_cannot_leave_root(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(PreparationError):
                child_path(Path(temp), "..", "outside.mp3")

    def test_mp3_and_sample_offsets_cover_all_paragraphs_and_gaps(self):
        try:
            ffmpeg, ffprobe = require_encoder()
        except PreparationError:
            self.skipTest("ffmpeg and ffprobe are required for this integration test")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            provider = TestProvider()
            paragraphs = [cache_paragraph(text, provider, root / "cache", 350) for text in ("First.", "Second.", "Third.")]
            intervals, frames, encoded_duration = encode_chapter(paragraphs, root / "chapter.mp3", 7200, ffmpeg, ffprobe)
            self.assertEqual(intervals, [(0, 9600), (9600, 19200), (19200, 21600)])
            self.assertEqual(frames, 21600)
            self.assertLess(abs(encoded_duration - 0.9), 0.20)
            self.assertGreater((root / "chapter.mp3").stat().st_size, 0)

    def test_partial_generation_merges_only_matching_generation_and_upload_verifies_files(self):
        try:
            require_encoder()
        except PreparationError:
            self.skipTest("ffmpeg and ffprobe are required for this integration test")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            common = [str(FIXTURE), "--book-id", "fixture", "--rights-confirmed", "--legacy-paragraph-mp3", "--output-root", str(root / "audio"), "--cache-root", str(root / "cache")]
            with contextlib.redirect_stdout(io.StringIO()):
                manifest_path = generate(arguments(common + ["--chapters", "1"]), TestProvider)
                manifest, plan, _ = upload_plan(manifest_path, root / "audio")
                self.assertFalse(manifest["coverage"]["complete"])
                self.assertEqual(manifest["coverage"]["chapterIndices"], [0])
                manifest_path = generate(arguments(common + ["--chapters", "2"]), TestProvider)
            manifest, plan, _ = upload_plan(manifest_path, root / "audio")
            self.assertTrue(manifest["coverage"]["complete"])
            self.assertEqual([chapter["chapterIndex"] for chapter in manifest["chapters"]], [0, 1])
            text = json.loads(FIXTURE.read_text())["chapters"][0]["paragraphs"][0]
            self.assertEqual(manifest["chapters"][0]["segments"][0]["textHash"], digest_text(text))
            chapter = manifest["chapters"][0]
            self.assertAlmostEqual(chapter["segments"][-1]["endSeconds"], chapter["durationSeconds"])
            self.assertNotIn(text, manifest_path.read_text())
            local_file = plan[0][0]
            with local_file.open("ab") as file:
                file.write(b"changed")
            with self.assertRaisesRegex(PreparationError, "changed"):
                upload_plan(manifest_path, root / "audio")

    def test_changed_settings_use_a_new_immutable_generation(self):
        try:
            require_encoder()
        except PreparationError:
            self.skipTest("ffmpeg and ffprobe are required for this integration test")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            common = [str(FIXTURE), "--book-id", "fixture", "--rights-confirmed", "--legacy-paragraph-mp3", "--output-root", str(root / "audio"), "--cache-root", str(root / "cache"), "--chapters", "1"]
            with contextlib.redirect_stdout(io.StringIO()):
                path = generate(arguments(common), TestProvider)
                previous = json.loads(path.read_text())
                path = generate(arguments(common + ["--paragraph-gap-ms", "400"]), TestProvider)
            current = json.loads(path.read_text())
            self.assertNotEqual(previous["generationId"], current["generationId"])
            self.assertNotEqual(previous["chapters"][0]["audioPath"], current["chapters"][0]["audioPath"])


class StorageTests(unittest.TestCase):
    def test_opaque_secret_key_is_sent_only_as_apikey_and_legacy_key_keeps_bearer(self):
        class Response:
            status = 200
        class Connection:
            def __init__(self, *_args, **_kwargs):
                self.headers = None
            def request(self, _method, _path, body=None, headers=None):
                self.headers = headers
            def getresponse(self):
                return Response()
            def close(self):
                pass
        for key in ("sb_secret_original_test_fixture_key", "legacy.test.fixture"):
            storage = SupabaseStorage("https://example.supabase.co", key, "private-audio")
            with patch("audio.upload.http.client.HTTPSConnection", Connection):
                connection, _ = storage._request("GET", "/storage/v1/bucket/private-audio")
            self.assertEqual(connection.headers["apikey"], key)
            if key.startswith("sb_secret_"):
                self.assertNotIn("Authorization", connection.headers)
            else:
                self.assertEqual(connection.headers["Authorization"], "Bearer " + key)

    def test_upload_activation_is_written_only_after_audio_and_metadata_succeed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest_path = root / "manifest.json"
            manifest = {"bookId": "fixture", "editionId": "v1", "generationId": "generation1", "narrator": {"id": "voice"}, "coverage": {"complete": True}}
            manifest_path.write_text(json.dumps(manifest))
            audio = root / "chapter.mp3"
            audio.write_bytes(b"chapter bytes")
            plan = [(audio, "fixture/v1/voice/generation1/chapter-0001.mp3", hashlib.sha256(audio.read_bytes()).hexdigest())]
            calls = []
            class Storage:
                bucket = "private-audio"
                url = "https://example.supabase.co"
                fail_manifest = True
                def __init__(self, *_):
                    pass
                def require_private_bucket(self, *_):
                    pass
                def _existing_matches(self, *_):
                    return True
                def upload(self, *args):
                    calls.append(args)
                    if len(args) > 4 and self.fail_manifest:
                        raise PreparationError("metadata upload failed")
            with patch.object(upload_audiobook, "upload_plan", return_value=(manifest, plan, root)), patch.object(upload_audiobook, "SupabaseStorage", Storage), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(upload_audiobook.main([str(manifest_path)]), 1)
                self.assertFalse((root / "published.json").exists())
                Storage.fail_manifest = False
                self.assertEqual(upload_audiobook.main([str(manifest_path)]), 0)
            marker = json.loads((root / "published.json").read_text())
            self.assertEqual(marker["manifestHash"], hashlib.sha256(manifest_path.read_bytes()).hexdigest())
            self.assertEqual(marker["generationId"], "generation1")
            self.assertEqual(marker["storageOrigin"], Storage.url)
            self.assertEqual(calls[-1][4], "application/json")

    def test_storage_configuration_does_not_accept_credentials_or_paths_in_url(self):
        for url in ("", "http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?key=secret"):
            with self.assertRaises(PreparationError):
                SupabaseStorage(url, "test-key", "private-audio")
        storage = SupabaseStorage("https://example.supabase.co", "test-key", "private-audio")
        for location in ("https://attacker.example/upload", "//attacker.example/upload", "/unrelated/path", "/storage/v1/upload/resumable/id?token=secret"):
            with self.assertRaises(PreparationError):
                storage._tus_path(location)

    def test_public_bucket_is_rejected(self):
        class Response:
            status = 200
            def read(self, *_):
                return b'{"public":true}'
        class Connection:
            def close(self):
                pass
        storage = SupabaseStorage("https://example.supabase.co", "test-key", "private-audio")
        with patch.object(storage, "_request", return_value=(Connection(), Response())):
            with self.assertRaisesRegex(PreparationError, "must be private"):
                storage.require_private_bucket()

    def test_existing_remote_object_is_hashed_before_reuse(self):
        payload = b"the same chapter bytes"
        class Response:
            status = 200
            def __init__(self):
                self.stream = io.BytesIO(payload)
            def read(self, size=-1):
                return self.stream.read(size)
        class Connection:
            def close(self):
                pass
        storage = SupabaseStorage("https://example.supabase.co", "test-key", "private-audio")
        with patch.object(storage, "_request", side_effect=lambda *_args, **_kwargs: (Connection(), Response())):
            self.assertTrue(storage._existing_matches("chapter.mp3", hashlib.sha256(payload).hexdigest()))
            with self.assertRaisesRegex(PreparationError, "different bytes"):
                storage._existing_matches("chapter.mp3", "0" * 64)

    def test_tus_upload_uses_fixed_chunks_and_resumes_from_server_offset(self):
        class Response:
            def __init__(self, status, headers=None):
                self.status = status
                self.headers = headers or {}
            def read(self, *_):
                return b""
            def getheader(self, name, default=None):
                return self.headers.get(name, default)
        class Connection:
            def close(self):
                pass
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            audio = root / "chapter.mp3"
            audio.write_bytes(b"x" * 300)
            state = root / "state.json"
            storage = SupabaseStorage("https://example.supabase.co", "test-key", "private-audio")
            calls = []
            def request(method, path, body=None, headers=None):
                calls.append((method, path, len(body or b""), headers))
                if method == "POST":
                    return Connection(), Response(201, {"Location": "/storage/v1/upload/resumable/session-id"})
                if method == "HEAD":
                    return Connection(), Response(200, {"Upload-Offset": "128"})
                return Connection(), Response(204, {"Upload-Offset": str(int(headers["Upload-Offset"]) + len(body))})
            with patch("audio.upload.TUS_CHUNK_BYTES", 128), patch.object(storage, "_request", side_effect=request):
                with contextlib.redirect_stdout(io.StringIO()):
                    storage._upload_tus(audio, "chapter.mp3", "hash", state)
                self.assertEqual([call[2] for call in calls if call[0] == "PATCH"], [128, 128, 44])
                self.assertEqual(json.loads(state.read_text()), {})
                state.write_text(json.dumps({"chapter.mp3": {"sha256": "hash", "origin": storage.url, "bucket": storage.bucket, "location": "/storage/v1/upload/resumable/session-id"}}))
                calls.clear()
                with contextlib.redirect_stdout(io.StringIO()):
                    storage._upload_tus(audio, "chapter.mp3", "hash", state)
                self.assertEqual([call[0] for call in calls], ["HEAD", "PATCH", "PATCH"])
                self.assertEqual([call[2] for call in calls if call[0] == "PATCH"], [128, 44])


if __name__ == "__main__":
    unittest.main()
