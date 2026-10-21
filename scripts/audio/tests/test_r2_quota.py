from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from audio.core import PreparationError
from audio.r2_quota import SupabaseR2Quota
from audio.r2_storage import R2Storage
from audio.tests.test_r2_storage import ACCOUNT, ACCESS, SECRET, FakeQuota, FakeS3


class R2QuotaTests(unittest.TestCase):
    def test_server_key_and_safe_origin_are_required_before_any_network(self):
        for url, key in [("http://project.test", "sb_secret_test"), ("https://user:pass@project.test", "sb_secret_test"), ("https://project.test/path", "key"), ("https://project.test", "")]:
            with self.assertRaises(PreparationError):
                SupabaseR2Quota(ACCOUNT, "readlay-audio", url, key)

    def test_opaque_secret_uses_apikey_without_bearer_and_reserves_exact_bytes(self):
        calls = []
        class Connection:
            def __init__(self, *args, **kwargs):
                calls.append((args, kwargs))
            def request(self, method, path, **kwargs):
                calls.append((method, path, kwargs))
            def getresponse(self):
                class Response:
                    status = 200
                    def read(self, _):
                        return b'{"allowed":true}'
                return Response()
            def close(self):
                pass
        quota = SupabaseR2Quota(ACCOUNT, "readlay-audio", "https://project.test", "sb_secret_testing")
        with patch("audio.r2_quota.http.client.HTTPSConnection", Connection):
            quota.reserve("PutObject", "ebooks/a/source.epub", 123)
        request = calls[1]
        self.assertEqual(request[:2], ("POST", "/rest/v1/rpc/readlay_r2_reserve"))
        self.assertEqual(request[2]["headers"]["apikey"], "sb_secret_testing")
        self.assertNotIn("Authorization", request[2]["headers"])
        self.assertEqual(json.loads(request[2]["body"])["p_bytes"], 123)

    def test_denied_quota_and_unknown_methods_cannot_reach_s3(self):
        class Denied:
            def reserve(self, *_):
                raise PreparationError("Quota exhausted")
        client = FakeS3()
        storage = R2Storage(ACCOUNT, ACCESS, SECRET, "readlay-audio", True, client, quota=Denied())
        with self.assertRaisesRegex(PreparationError, "Quota exhausted"):
            storage.require_private_bucket()
        with self.assertRaisesRegex(PreparationError, "Quota exhausted"):
            storage._existing_matches("key", "a" * 64)
        with self.assertRaisesRegex(PreparationError, "not authorised"):
            storage._call("delete_object", Bucket="readlay-audio", Key="key")
        self.assertEqual(client.puts, [])

    def test_every_attempt_and_readback_is_reserved_and_uploads_use_standard_storage(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.epub"
            source.write_bytes(b"prepared epub fixture")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            quota, client = FakeQuota(), FakeS3()
            storage = R2Storage(ACCOUNT, ACCESS, SECRET, "readlay-audio", True, client, quota=quota)
            storage.upload(source, "ebooks/a/source.epub", digest, root / "unused", "application/epub+zip")
            self.assertTrue(storage._existing_matches("ebooks/a/source.epub", digest))
            self.assertEqual(quota.calls, [("GetObject", None, 0), ("PutObject", "ebooks/a/source.epub", len(source.read_bytes())), ("GetObject", None, 0)])
            self.assertEqual(client.puts[0]["StorageClass"], "STANDARD")
            self.assertEqual(client.puts[0]["IfNoneMatch"], "*")

    def test_failed_quota_service_redacts_secrets_and_cannot_authorise_a_request(self):
        class Connection:
            def __init__(self, *_args, **_kwargs):
                pass
            def request(self, *_args, **_kwargs):
                raise OSError("sb_secret_testing and private signed request")
            def close(self):
                pass
        quota = SupabaseR2Quota(ACCOUNT, "readlay-audio", "https://project.test", "sb_secret_testing")
        with patch("audio.r2_quota.http.client.HTTPSConnection", Connection), self.assertRaises(PreparationError) as caught:
            quota.reserve("GetObject")
        self.assertNotIn("sb_secret_testing", str(caught.exception))
        self.assertIsNone(caught.exception.__cause__)


if __name__ == "__main__":
    unittest.main()
