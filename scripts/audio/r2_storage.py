"""Private Cloudflare R2 uploads through its supported S3 API.

Bucket public access is configured and checked in the Cloudflare dashboard.
The object-scoped S3 key cannot inspect the separate r2.dev/custom-domain
settings, so preparation requires that explicit operator confirmation.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .core import PreparationError, file_digest

MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3


class R2Storage:
    provider = "r2"

    def __init__(self, account_id: str, access_key: str, secret_key: str,
                 bucket: str, private_bucket_confirmed: bool = False, client=None):
        if not isinstance(account_id, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", account_id):
            raise PreparationError("R2_ACCOUNT_ID must be the 32-character account identifier.")
        if not isinstance(access_key, str) or not isinstance(secret_key, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", access_key) or not re.fullmatch(r"[a-fA-F0-9]{64}", secret_key):
            raise PreparationError("Add the R2 S3 access key and secret to the server-only environment fields.")
        if private_bucket_confirmed is not True:
            raise PreparationError("Verify that r2.dev access and public custom domains are disabled, then use --private-bucket-confirmed. S3 credentials cannot inspect those dashboard settings.")
        if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket):
            raise PreparationError("R2_AUDIO_BUCKET must contain 3 to 63 lowercase letters, numbers or hyphens, with a letter or number at each end.")
        self.bucket = bucket
        self.url = f"https://{account_id.lower()}.r2.cloudflarestorage.com"
        if client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as error:
                raise PreparationError("Install requirements-audio-storage.txt in the local upload environment.") from error
            try:
                client = boto3.client("s3", endpoint_url=self.url, region_name="auto",
                                      aws_access_key_id=access_key, aws_secret_access_key=secret_key,
                                      config=Config(signature_version="s3v4", connect_timeout=15,
                                                    read_timeout=120, retries={"max_attempts": 3},
                                                    s3={"addressing_style": "path"}))
            except Exception:
                raise PreparationError("R2 could not initialise its S3 client. Check the local storage packages and server-only configuration.") from None
        self.client = client

    def _call(self, operation, allow_missing=False, **kwargs):
        try:
            response = getattr(self.client, operation)(**kwargs)
        except Exception as error:
            # Do not expose signed requests, credentials or SDK response bodies.
            details = getattr(error, "response", None)
            details = details.get("Error") if isinstance(details, dict) else None
            code = details.get("Code") if isinstance(details, dict) else None
            if allow_missing and code in ("NoSuchKey", "NotFound", "404"):
                return None
            raise PreparationError(f"R2 {operation.replace('_', ' ')} failed. Check the private bucket, key permissions and network connection; existing objects were kept.") from None
        if not isinstance(response, dict):
            raise PreparationError("R2 returned an invalid storage response. No publication receipt was changed.")
        metadata = response.get("ResponseMetadata", {})
        status = metadata.get("HTTPStatusCode") if isinstance(metadata, dict) else None
        if type(status) is not int or not 200 <= status < 300:
            raise PreparationError("R2 did not confirm a successful storage request. No publication receipt was changed.")
        return response

    def require_private_bucket(self, create=False, content_types=()):
        if create:
            raise PreparationError("Create the private R2 bucket in Cloudflare first. This uploader cannot create buckets or enable public access.")
        if self._call("head_bucket", Bucket=self.bucket) is None:
            raise PreparationError("The configured R2 bucket is unavailable.")

    def _existing_matches(self, object_path: str, expected_hash: str) -> bool:
        response = self._call("get_object", allow_missing=True, Bucket=self.bucket, Key=object_path)
        if response is None:
            return False
        if not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            raise PreparationError("R2 verification requires the exact prepared SHA256 digest.")
        stream = response.get("Body")
        if stream is None:
            raise PreparationError("R2 returned no object body for SHA256 verification.")
        digest = hashlib.sha256()
        try:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                if not isinstance(block, bytes):
                    raise ValueError("Invalid object stream")
                digest.update(block)
        except Exception:
            raise PreparationError("R2 object readback failed. No object was accepted without complete SHA256 verification.") from None
        finally:
            try:
                stream.close()
            except Exception:
                raise PreparationError("R2 object readback could not close cleanly. Verification was not accepted.") from None
        if digest.hexdigest() != expected_hash:
            raise PreparationError("An R2 object already exists at this versioned path with different bytes. It was not overwritten.")
        return True

    def upload(self, local_path: Path, object_path: str, expected_hash: str,
               state_path: Path, content_type: str = "audio/ogg"):
        size = local_path.stat().st_size
        if not 0 < size <= MAX_SINGLE_PUT_BYTES:
            raise PreparationError("R2 chapter uploads must be non-empty files no larger than the 5 GiB single-request limit.")
        if content_type not in ("audio/ogg", "audio/mpeg", "application/json", "application/gzip"):
            raise PreparationError("Use an approved audiobook or manifest content type for R2 uploads.")
        if file_digest(local_path) != expected_hash:
            raise PreparationError("The local upload file changed after validation.")
        if self._existing_matches(object_path, expected_hash):
            print("Verified identical existing R2 object; kept it unchanged.")
            return
        # Chapter files are comfortably below S3's single PUT limit. An
        # interrupted PUT is retried from the retained local chapter. The
        # conditional request closes the race after the existence check.
        with local_path.open("rb") as body:
            self._call("put_object", Bucket=self.bucket, Key=object_path, Body=body,
                       ContentLength=size, ContentType=content_type,
                       CacheControl="private, max-age=31536000, immutable", IfNoneMatch="*")
