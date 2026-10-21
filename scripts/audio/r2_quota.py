"""Server-authorised, atomic R2 reservations in the existing Supabase project."""
from __future__ import annotations

import http.client
import json
import os
from urllib.parse import urlsplit

from .core import PreparationError


class SupabaseR2Quota:
    def __init__(self, account: str, bucket: str, url: str | None = None, secret: str | None = None):
        self.account, self.bucket = account, bucket
        self.url = urlsplit(url if url is not None else os.environ.get("SUPABASE_URL", ""))
        self.secret = secret if secret is not None else os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if self.url.scheme != "https" or not self.url.hostname or self.url.username or self.url.password or self.url.path not in ("", "/") or self.url.query or self.url.fragment or not self.secret or any(c.isspace() for c in self.secret):
            raise PreparationError("R2 uploads require server-only SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for quota authorisation. No R2 request was made.")

    def reserve(self, operation: str, object_key: str | None = None, byte_length: int = 0):
        payload = json.dumps({"p_account_id": self.account, "p_bucket": self.bucket, "p_operation": operation,
                              "p_subject": "operator", "p_object_key": object_key, "p_bytes": byte_length}).encode()
        headers = {"apikey": self.secret, "Content-Type": "application/json", "Content-Length": str(len(payload))}
        if not self.secret.startswith("sb_secret_"):
            headers["Authorization"] = "Bearer " + self.secret
        connection = http.client.HTTPSConnection(self.url.hostname, self.url.port, timeout=15)
        try:
            # http.client does not follow redirects carrying a privileged key.
            connection.request("POST", "/rest/v1/rpc/readlay_r2_reserve", body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read(16_385)
            if response.status != 200 or len(raw) > 16_384:
                raise ValueError("Quota service unavailable")
            result = json.loads(raw)
        except (OSError, http.client.HTTPException, ValueError):
            raise PreparationError("R2 quota authorisation could not be verified. No storage request was made; an uncertain reservation is kept.") from None
        finally:
            connection.close()
        if not isinstance(result, dict) or result.get("allowed") is not True:
            reason = result.get("reason") if isinstance(result, dict) else None
            messages = {"storage_limit": "The 9 GB storage safety limit would be reached.",
                        "class_a_limit": "The Class A safety controls have paused requests.",
                        "class_b_limit": "The Class B safety controls have paused requests.",
                        "verification_limit": "No quota remains for upload verification reads.",
                        "uploads_paused": "Uploads are paused by the administrator.",
                        "paused": "All application-controlled R2 operations are paused.",
                        "multipart_pending": "Unfinished multipart uploads need review."}
            raise PreparationError(messages.get(reason, "R2 usage is missing, stale or unavailable. Refresh usage in the admin dashboard before uploading.") + " Existing files were kept.")
