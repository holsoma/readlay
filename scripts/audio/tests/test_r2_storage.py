from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))

from audio.core import PreparationError
from audio.r2_storage import R2Storage
import upload_audiobook

ACCOUNT, ACCESS, SECRET = "a" * 32, "b" * 32, "c" * 64


class FakeQuota:
    def __init__(self):
        self.calls = []
    def reserve(self, operation, key=None, size=0):
        self.calls.append((operation, key, size))


class S3Error(Exception):
    def __init__(self, code, message="SDK PRIVATE SIGNED REQUEST AND SECRET"):
        super().__init__(message)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self):
        self.objects, self.puts, self.streams = {}, [], []
        self.failure, self.corrupt = None, False

    def head_bucket(self, **_):
        if self.failure:
            raise S3Error(self.failure)
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def get_object(self, Bucket, Key):
        if self.failure:
            raise S3Error(self.failure)
        if Key not in self.objects:
            raise S3Error("NoSuchKey")
        stream = io.BytesIO(self.objects[Key])
        self.streams.append(stream)
        return {"ResponseMetadata": {"HTTPStatusCode": 200}, "Body": stream}

    def put_object(self, **options):
        if self.failure:
            raise S3Error(self.failure)
        if options["IfNoneMatch"] != "*":
            raise AssertionError("Writes must be conditional")
        if options["Key"] in self.objects:
            raise S3Error("PreconditionFailed")
        content = options["Body"].read()
        self.puts.append({key: value for key, value in options.items() if key != "Body"})
        corrupt = self.corrupt is True or self.corrupt == options["ContentType"]
        self.objects[options["Key"]] = b"corrupt readback" if corrupt else content
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


class R2StorageTests(unittest.TestCase):
    def storage(self, client=None):
        return R2Storage(ACCOUNT, ACCESS, SECRET, "readlay-audio", True, client or FakeS3(), quota=FakeQuota())

    def test_private_confirmation_and_r2_bucket_names_are_strict(self):
        for confirmation in (False, None, "true", 1):
            with self.subTest(confirmation=confirmation), self.assertRaisesRegex(PreparationError, "private-bucket-confirmed"):
                R2Storage(ACCOUNT, ACCESS, SECRET, "readlay-audio", confirmation, FakeS3())
        for bucket in ("ab", "a" * 64, "Uppercase", "with_underscore", "with.dot", "-leading", "trailing-", None):
            with self.subTest(bucket=bucket), self.assertRaisesRegex(PreparationError, "R2_AUDIO_BUCKET"):
                R2Storage(ACCOUNT, ACCESS, SECRET, bucket, True, FakeS3())
        for account, access, secret in (("", ACCESS, SECRET), (ACCOUNT, "wrong", SECRET), (ACCOUNT, ACCESS, "bad"), (None, ACCESS, SECRET)):
            with self.assertRaises(PreparationError):
                R2Storage(account, access, secret, "readlay-audio", True, FakeS3())
        self.storage().require_private_bucket()
        with self.assertRaisesRegex(PreparationError, "cannot create"):
            self.storage().require_private_bucket(create=True)

    def test_immutable_put_and_sha256_readback_reuse(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            path = root / "chapter.opus"
            path.write_bytes(b"exact prepared chapter")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            client = FakeS3()
            storage = self.storage(client)
            key = "fixture/v1/narrator/generation/chapter-0001.opus"
            storage.upload(path, key, digest, root / "state.json")
            self.assertTrue(storage._existing_matches(key, digest))
            storage.upload(path, key, digest, root / "state.json")
            self.assertEqual(len(client.puts), 1)
            self.assertEqual(client.puts[0]["IfNoneMatch"], "*")
            self.assertEqual(client.puts[0]["ContentLength"], len(path.read_bytes()))
            self.assertEqual(client.puts[0]["ContentType"], "audio/ogg")
            self.assertTrue(all(stream.closed for stream in client.streams))
            self.assertFalse((root / "state.json").exists(), "Single PUTs do not create fictitious multipart state")

    def test_existing_mismatched_object_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "chapter.opus"
            path.write_bytes(b"new bytes")
            client = FakeS3()
            client.objects["key"] = b"old bytes"
            storage = self.storage(client)
            with self.assertRaisesRegex(PreparationError, "different bytes"):
                storage.upload(path, "key", hashlib.sha256(path.read_bytes()).hexdigest(), root / "state.json")
            self.assertEqual(client.objects["key"], b"old bytes")
            self.assertEqual(client.puts, [])

    def test_sdk_failures_and_stream_errors_are_redacted_and_fail_closed(self):
        for code in ("AccessDenied", "SignatureDoesNotMatch", "NoSuchBucket"):
            client = FakeS3()
            client.failure = code
            with self.assertRaises(PreparationError) as caught:
                self.storage(client)._existing_matches("key", "a" * 64)
            self.assertNotIn("PRIVATE", str(caught.exception))
            self.assertIsNone(caught.exception.__cause__)
        class BrokenStream:
            closed = False
            def read(self, _):
                raise RuntimeError("PRIVATE SIGNED URL AND SECRET")
            def close(self):
                self.closed = True
        stream = BrokenStream()
        class StreamClient(FakeS3):
            def get_object(self, **_):
                return {"ResponseMetadata": {"HTTPStatusCode": 200}, "Body": stream}
        with self.assertRaisesRegex(PreparationError, "readback failed") as caught:
            self.storage(StreamClient())._existing_matches("key", "a" * 64)
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertTrue(stream.closed)
        for response in (None, {}, {"ResponseMetadata": {"HTTPStatusCode": 403}}):
            class MalformedClient(FakeS3):
                def head_bucket(self, **_):
                    return response
            with self.assertRaises(PreparationError):
                self.storage(MalformedClient()).require_private_bucket()

    def test_put_missing_bucket_and_conditional_race_are_errors_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "chapter.opus"
            path.write_bytes(b"prepared")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            for code in ("404", "PreconditionFailed"):
                class FailedPut(FakeS3):
                    def put_object(self, **_):
                        raise S3Error(code)
                with self.assertRaisesRegex(PreparationError, "put object failed"):
                    self.storage(FailedPut()).upload(path, "key", digest, root / "state.json")

    def test_local_changes_and_oversized_files_fail_before_network(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "chapter.opus"
            path.write_bytes(b"prepared")
            storage = self.storage()
            with self.assertRaisesRegex(PreparationError, "changed"):
                storage.upload(path, "key", "0" * 64, root / "state.json")
            with patch("audio.r2_storage.MAX_SINGLE_PUT_BYTES", 4), self.assertRaisesRegex(PreparationError, "5 GiB"):
                storage.upload(path, "key", hashlib.sha256(path.read_bytes()).hexdigest(), root / "state.json")
            self.assertEqual(storage.client.puts, [])

    def test_r2_readback_failure_keeps_existing_supabase_publication_receipts(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            root = Path(temp)
            manifest_path = root / "manifest.json"
            manifest = {"bookId": "fixture", "editionId": "v1", "generationId": "generation1", "schemaVersion": 2,
                        "narrator": {"id": "voice"}, "coverage": {"complete": True}}
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            chapter = root / "chapter.opus"
            chapter.write_bytes(b"prepared chapter")
            plan = [(chapter, "fixture/v1/voice/generation1/chapter-0001.opus", hashlib.sha256(chapter.read_bytes()).hexdigest())]
            publication = root / "published.json"
            receipt = root / "upload-receipt.json"
            publication.write_text('{"storageProvider":"supabase","existing":"publication"}', encoding="utf-8")
            receipt.write_text('{"existing":"verified supabase receipt"}', encoding="utf-8")
            originals = publication.read_bytes(), receipt.read_bytes()
            environment = {"R2_ACCOUNT_ID": ACCOUNT, "R2_ACCESS_KEY_ID": ACCESS, "R2_SECRET_ACCESS_KEY": SECRET, "R2_AUDIO_BUCKET": "readlay-audio"}
            for corrupt_type in ("audio/ogg", "application/json"):
                client = FakeS3()
                client.corrupt = corrupt_type
                def storage_factory(*settings):
                    return R2Storage(*settings, client=client, quota=FakeQuota())
                with self.subTest(corrupt_type=corrupt_type), patch.object(upload_audiobook, "upload_plan", return_value=(manifest, plan, root)), patch("audio.r2_storage.R2Storage", side_effect=storage_factory), patch.dict(os.environ, environment):
                    self.assertEqual(upload_audiobook.main([str(manifest_path), "--storage", "r2", "--private-bucket-confirmed"]), 1)
                self.assertEqual((publication.read_bytes(), receipt.read_bytes()), originals)


if __name__ == "__main__":
    unittest.main()
