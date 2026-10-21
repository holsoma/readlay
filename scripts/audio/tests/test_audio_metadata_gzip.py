from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))

from audio.r2_storage import R2Storage
from pack_audio_metadata import pack
from test_r2_storage import ACCOUNT, ACCESS, SECRET, FakeS3
import upload_audiobook


class MemorySupabase:
    bucket = "readlay-audio"
    url = "https://fixture.supabase.co"

    def __init__(self, *_):
        self.objects, self.uploads, self.allowed = {}, [], ()
        self.corrupt_gzip = False

    def require_private_bucket(self, _create=False, content_types=()):
        self.allowed = content_types

    def upload(self, path, object_path, expected_hash, _state, content_type="audio/mpeg"):
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != expected_hash:
            raise AssertionError("The uploader supplied the wrong remote byte digest")
        self.objects[object_path] = b"bad gzip readback" if self.corrupt_gzip and content_type == "application/gzip" else content
        self.uploads.append({"Key": object_path, "ContentType": content_type})

    def _existing_matches(self, key, expected_hash):
        return key in self.objects and hashlib.sha256(self.objects[key]).hexdigest() == expected_hash


class AudioMetadataGzipTests(unittest.TestCase):
    def fixture(self, root: Path, schema: int):
        base = root / "source"
        base.mkdir()
        generation_id = "a1" * 12
        generation = base / generation_id
        generation.mkdir()
        manifest = {"bookId": "fixture", "editionId": "v1", "generationId": generation_id, "schemaVersion": schema,
                    "narrator": {"id": "voice"}, "coverage": {"complete": True}, "originalTextEncoding": "caf\u00e9"}
        content = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        path = base / "manifest.json"
        path.write_bytes(content)
        suffix = "opus" if schema == 2 else "mp3"
        chapter = generation / ("chapter-0001." + suffix)
        chapter.write_bytes(b"prepared chapter bytes")
        remote = f"fixture/v1/voice/{generation_id}/chapter-0001.{suffix}"
        plan = [(chapter, remote, hashlib.sha256(chapter.read_bytes()).hexdigest())]
        return path, content, manifest, plan, generation

    @contextlib.contextmanager
    def storage(self, backend: str, corrupt_gzip: bool = False):
        if backend == "supabase":
            storage = MemorySupabase()
            storage.corrupt_gzip = corrupt_gzip
            with patch.object(upload_audiobook, "SupabaseStorage", return_value=storage):
                yield storage, storage.uploads
        else:
            client = FakeS3()
            client.corrupt = "application/gzip" if corrupt_gzip else False
            def create(*settings):
                return R2Storage(*settings, client=client)
            environment = {"R2_ACCOUNT_ID": ACCOUNT, "R2_ACCESS_KEY_ID": ACCESS, "R2_SECRET_ACCESS_KEY": SECRET, "R2_AUDIO_BUCKET": "readlay-audio"}
            with patch("audio.r2_storage.R2Storage", side_effect=create), patch.dict(os.environ, environment):
                yield client, client.puts

    def test_compressed_upload_preserves_original_hash_and_uses_remote_compressed_digest(self):
        for backend in ("supabase", "r2"):
            for schema in (1, 2):
                with self.subTest(backend=backend, schema=schema), tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
                    root = Path(temp)
                    path, original, manifest, plan, generation = self.fixture(root, schema)
                    with self.storage(backend) as (storage, uploads), patch.object(upload_audiobook, "upload_plan", return_value=(manifest, plan, generation)):
                        status = upload_audiobook.main([str(path), "--storage", backend, "--gzip-manifest", "--private-bucket-confirmed"])
                    self.assertEqual(status, 0)
                    self.assertEqual(path.read_bytes(), original, "Compression must preserve the exact original bytes")
                    original_hash = hashlib.sha256(original).hexdigest()
                    receipt = json.loads((generation / "upload-receipt.json").read_text())
                    publication = json.loads((path.parent / "published.json").read_text())
                    self.assertEqual(publication["manifestHash"], original_hash)
                    self.assertEqual(receipt["manifestSha256"], original_hash)
                    remote = receipt["remoteManifestPath"]
                    self.assertTrue(remote.endswith(f"manifest-{original_hash}.json.gz"))
                    packed = storage.objects[remote]
                    self.assertEqual(gzip.decompress(packed), original)
                    self.assertEqual(receipt["remoteManifestSha256"], hashlib.sha256(packed).hexdigest())
                    self.assertNotEqual(receipt["remoteManifestSha256"], original_hash)
                    self.assertEqual(uploads[-1]["ContentType"], "application/gzip")
                    self.assertEqual(uploads[0]["ContentType"], "audio/ogg" if schema == 2 else "audio/mpeg")
                    self.assertEqual(publication["storageProvider"], backend)

    def test_failed_compressed_readback_preserves_existing_publication_and_upload_receipts(self):
        for backend in ("supabase", "r2"):
            with self.subTest(backend=backend), tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                root = Path(temp)
                path, original, manifest, plan, generation = self.fixture(root, 2)
                publication_path, receipt_path = path.parent / "published.json", generation / "upload-receipt.json"
                publication_path.write_bytes(b'{"storageProvider":"supabase","existing":"verified publication"}')
                receipt_path.write_bytes(b'{"existing":"verified upload receipt"}')
                previous = publication_path.read_bytes(), receipt_path.read_bytes()
                with self.storage(backend, corrupt_gzip=True), patch.object(upload_audiobook, "upload_plan", return_value=(manifest, plan, generation)):
                    self.assertEqual(upload_audiobook.main([str(path), "--storage", backend, "--gzip-manifest", "--private-bucket-confirmed"]), 1)
                self.assertEqual((publication_path.read_bytes(), receipt_path.read_bytes()), previous)
                self.assertEqual(path.read_bytes(), original)

    def test_packing_published_metadata_preserves_exact_bytes_and_is_deterministic(self):
        with tempfile.TemporaryDirectory() as temp:
            path, original, manifest, _, _ = self.fixture(Path(temp), 2)
            receipt = {"generationId": manifest["generationId"], "manifestHash": hashlib.sha256(original).hexdigest()}
            receipt_path = path.parent / "published.json"
            receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
            receipt_bytes = receipt_path.read_bytes()
            sizes = pack(path.parent)
            first = (path.parent / "manifest.json.gz").read_bytes()
            self.assertEqual(sizes, (len(original), len(first)))
            self.assertEqual(gzip.decompress(first), original)
            pack(path.parent)
            self.assertEqual((path.parent / "manifest.json.gz").read_bytes(), first)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(receipt_path.read_bytes(), receipt_bytes)

    def test_packing_rejects_changed_generation_or_hash_without_replacing_existing_gzip(self):
        with tempfile.TemporaryDirectory() as temp:
            path, original, manifest, _, _ = self.fixture(Path(temp), 2)
            target = path.parent / "manifest.json.gz"
            target.write_bytes(b"previous verified compressed file")
            for receipt in ({"generationId": manifest["generationId"], "manifestHash": "0" * 64},
                            {"generationId": "other-generation", "manifestHash": hashlib.sha256(original).hexdigest()}):
                (path.parent / "published.json").write_text(json.dumps(receipt), encoding="utf-8")
                with self.assertRaises(ValueError):
                    pack(path.parent)
                self.assertEqual(target.read_bytes(), b"previous verified compressed file")

    def test_packing_rejects_missing_generation_and_non_object_receipts(self):
        with tempfile.TemporaryDirectory() as temp:
            path, original, _, _, _ = self.fixture(Path(temp), 2)
            for manifest, receipt in (({}, {}), ({"generationId": "a1" * 12}, [])):
                content = json.dumps(manifest).encode()
                path.write_bytes(content)
                if isinstance(receipt, dict):
                    receipt["manifestHash"] = hashlib.sha256(content).hexdigest()
                (path.parent / "published.json").write_text(json.dumps(receipt), encoding="utf-8")
                with self.assertRaises(ValueError):
                    pack(path.parent)
                self.assertFalse((path.parent / "manifest.json.gz").exists())

    def test_packing_checks_file_size_before_reading_or_parsing_unbounded_bytes(self):
        with patch("pack_audio_metadata.Path.stat", return_value=SimpleNamespace(st_size=64 * 1024 * 1024 + 1)), \
                patch("pack_audio_metadata.Path.read_bytes") as read:
            with self.assertRaisesRegex(ValueError, "bounded decompression"):
                pack(Path("unused-fixture"))
            read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
