"""Small standard-library Supabase uploader with immutable objects and TUS."""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

from .core import PreparationError, atomic_json, child_path, file_digest, identifier

TUS_CHUNK_BYTES = 6 * 1024 * 1024


def is_missing(status: int, payload: bytes) -> bool:
    if status == 404:
        return True
    if status != 400:
        return False
    # Older Supabase deployments wrap a storage 404 in an HTTP 400 response.
    try:
        value = json.loads(payload)
    except ValueError:
        return False
    return isinstance(value, dict) and (str(value.get("statusCode")) == "404" or value.get("code") in ("NoSuchKey", "NoSuchBucket"))


class StorageError(PreparationError):
    def __init__(self, status: int, operation: str):
        self.status = status
        super().__init__(f"Storage {operation} failed (HTTP {status}). Check credentials, bucket limits and network access. No existing object was overwritten.")


class SupabaseStorage:
    def __init__(self, url: str, key: str, bucket: str):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise PreparationError("SUPABASE_URL must be the HTTPS project origin without credentials, a path or a query.")
        if not key.strip() or any(character.isspace() for character in key):
            raise PreparationError("SUPABASE_SERVICE_ROLE_KEY is missing or invalid.")
        self.url = url.rstrip("/")
        self.key = key
        self.bucket = identifier(bucket, "AUDIO_STORAGE_BUCKET")

    def _request(self, method: str, path: str, body=None, headers: dict | None = None):
        parsed = urlsplit(self.url)
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=120)
        complete_headers = {"apikey": self.key}
        # Opaque sb_secret_ API keys are not JWT bearer tokens.
        if not self.key.startswith("sb_secret_"):
            complete_headers["Authorization"] = f"Bearer {self.key}"
        complete_headers.update(headers or {})
        try:
            # http.client deliberately does not follow redirects with privileged headers.
            connection.request(method, path, body=body, headers=complete_headers)
            response = connection.getresponse()
            return connection, response
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            raise PreparationError("Storage could not be reached. Check network access, then run the upload command again.") from error

    def require_private_bucket(self, create: bool = False, content_types: tuple[str, ...] = ("audio/mpeg", "application/json")) -> None:
        connection, response = self._request("GET", "/storage/v1/bucket/" + quote(self.bucket, safe=""))
        status = response.status
        payload = response.read(128 * 1024)
        connection.close()
        if is_missing(status, payload) and create:
            body = json.dumps({"id": self.bucket, "name": self.bucket, "public": False, "allowed_mime_types": list(content_types)}).encode()
            connection, response = self._request("POST", "/storage/v1/bucket", body, {"Content-Type": "application/json", "Content-Length": str(len(body))})
            status = response.status
            response.read(128 * 1024)
            connection.close()
            if status not in (200, 201):
                raise StorageError(status, "bucket creation")
            return
        if status != 200:
            raise StorageError(status, "bucket check")
        try:
            bucket = json.loads(payload)
        except ValueError as error:
            raise PreparationError("Storage returned an invalid bucket response.") from error
        if not isinstance(bucket, dict) or bucket.get("public") is not False:
            raise PreparationError("The audiobook bucket must be private. This command will not publish to a public bucket.")
        allowed_types = bucket.get("allowed_mime_types")
        if isinstance(allowed_types, list) and not all(mime in allowed_types or mime.split("/")[0] + "/*" in allowed_types or "*/*" in allowed_types for mime in content_types):
            raise PreparationError("The private bucket must allow " + ", ".join(content_types) + ". Update its MIME type settings first; keep the bucket private.")

    def _existing_matches(self, object_path: str, expected_hash: str) -> bool:
        connection, response = self._request("GET", "/storage/v1/object/authenticated/" + quote(self.bucket, safe="") + "/" + quote(object_path, safe="/"))
        if response.status != 200:
            status = response.status
            payload = response.read(128 * 1024)
            connection.close()
            if is_missing(status, payload):
                return False
            raise StorageError(status, "existing object verification")
        digest = hashlib.sha256()
        try:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(block)
        finally:
            connection.close()
        if digest.hexdigest() != expected_hash:
            raise PreparationError("An object already exists at this versioned path with different bytes. Keep it unchanged and generate a new asset version.")
        return True

    def upload(self, local_path: Path, object_path: str, expected_hash: str, state_path: Path, content_type: str = "audio/mpeg") -> None:
        if self._existing_matches(object_path, expected_hash):
            print("Verified identical existing object; kept it unchanged.")
            return
        size = local_path.stat().st_size
        if size <= TUS_CHUNK_BYTES:
            with local_path.open("rb") as source:
                connection, response = self._request("POST", "/storage/v1/object/" + quote(self.bucket, safe="") + "/" + quote(object_path, safe="/"), source, {"Content-Type": content_type, "Content-Length": str(size), "x-upsert": "false", "Cache-Control": "max-age=31536000"})
                status = response.status
                response.read(128 * 1024)
                connection.close()
            if status not in (200, 201):
                raise StorageError(status, "object upload")
            return
        self._upload_tus(local_path, object_path, expected_hash, state_path, content_type)

    def _tus_path(self, location: str) -> str:
        absolute = urlsplit(urljoin(self.url + "/", location))
        configured = urlsplit(self.url)
        if absolute.scheme != configured.scheme or absolute.netloc != configured.netloc or not absolute.path.startswith("/storage/v1/upload/resumable/") or absolute.query or absolute.fragment:
            raise PreparationError("Storage returned an unexpected resumable upload URL. Credentials were not sent to it.")
        return absolute.path

    def _upload_tus(self, path: Path, object_path: str, expected_hash: str, state_path: Path, content_type: str = "audio/mpeg") -> None:
        size = path.stat().st_size
        state = {}
        if state_path.is_file():
            try:
                state = json.loads(state_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                state = {}
        session = state.get(object_path, {}) if isinstance(state, dict) else {}
        upload_path = None
        if session.get("sha256") == expected_hash and session.get("origin") == self.url and session.get("bucket") == self.bucket:
            upload_path = self._tus_path(session.get("location", ""))
        offset = 0
        if upload_path:
            connection, response = self._request("HEAD", upload_path, headers={"Tus-Resumable": "1.0.0"})
            status = response.status
            if status == 200 or status == 204:
                try:
                    offset = int(response.getheader("Upload-Offset", "-1"))
                except ValueError:
                    offset = -1
                if not 0 <= offset <= size:
                    raise PreparationError("Storage returned an invalid resumable upload offset.")
            elif status in (404, 410):
                upload_path = None
            else:
                response.read(128 * 1024)
                connection.close()
                raise StorageError(status, "upload resume")
            response.read(128 * 1024)
            connection.close()
        if not upload_path:
            metadata = {"bucketName": self.bucket, "objectName": object_path, "contentType": content_type, "cacheControl": "31536000"}
            encoded_metadata = ",".join(name + " " + base64.b64encode(value.encode()).decode("ascii") for name, value in metadata.items())
            connection, response = self._request("POST", "/storage/v1/upload/resumable", b"", {"Tus-Resumable": "1.0.0", "Upload-Length": str(size), "Upload-Metadata": encoded_metadata, "Content-Length": "0", "x-upsert": "false"})
            status = response.status
            location = response.getheader("Location", "")
            response.read(128 * 1024)
            connection.close()
            if status != 201:
                raise StorageError(status, "resumable upload creation")
            upload_path = self._tus_path(location)
            if not isinstance(state, dict):
                state = {}
            state[object_path] = {"sha256": expected_hash, "origin": self.url, "bucket": self.bucket, "location": upload_path}
            atomic_json(state_path, state)
        with path.open("rb") as source:
            source.seek(offset)
            while offset < size:
                chunk = source.read(TUS_CHUNK_BYTES)
                connection, response = self._request("PATCH", upload_path, chunk, {"Tus-Resumable": "1.0.0", "Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream", "Content-Length": str(len(chunk)), "x-upsert": "false"})
                status = response.status
                next_offset = response.getheader("Upload-Offset", "")
                response.read(128 * 1024)
                connection.close()
                if status != 204:
                    raise StorageError(status, "resumable chunk upload; retry the command to resume")
                if next_offset != str(offset + len(chunk)):
                    raise PreparationError("Storage returned an unexpected upload offset. Run the command again to resume safely.")
                offset += len(chunk)
                print(f"Uploaded {offset:,}/{size:,} bytes.", flush=True)
        state.pop(object_path, None)
        atomic_json(state_path, state)


def upload_plan(manifest_path: Path, output_root: Path) -> tuple[dict, list[tuple[Path, str, str]], Path]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise PreparationError("The manifest must be readable JSON.") from error
    legacy = isinstance(manifest, dict) and manifest.get("schemaVersion") == 1 and manifest.get("alignment") == "paragraph"
    word_audio = isinstance(manifest, dict) and manifest.get("schemaVersion") == 2 and manifest.get("alignment") == "word" and manifest.get("format") == "opus" and manifest.get("locationScheme") == "readlay-canonical-epub-v1"
    if not (legacy or word_audio) or manifest.get("sampleRate") != 24000:
        raise PreparationError("The manifest is not a supported paragraph MP3 or word-aligned Opus audiobook.")
    book_id = identifier(manifest.get("bookId", ""), "bookId")
    edition_id = identifier(manifest.get("editionId", ""), "editionId")
    narrator = manifest.get("narrator")
    if not isinstance(narrator, dict) or narrator.get("engine") != "kokoro":
        raise PreparationError("The manifest narrator is invalid.")
    narrator_id = identifier(narrator.get("id", ""), "narratorId")
    generation_id = identifier(manifest.get("generationId", ""), "generationId")
    base = child_path(output_root, book_id, edition_id, narrator_id)
    if manifest_path.resolve() not in ((base / "manifest.json").resolve(), (base / generation_id / "manifest.json").resolve()):
        raise PreparationError("The manifest is outside its declared audiobook folder.")
    generation_base = child_path(base, generation_id)
    try:
        preparation = json.loads((generation_base / "preparation.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise PreparationError("The private preparation record is missing. Generate this audiobook with recorded audio distribution permission first.") from error
    if not isinstance(preparation, dict) or preparation.get("bookId") != book_id or preparation.get("editionId") != edition_id or preparation.get("generationId") != generation_id or not isinstance(preparation.get("rights"), dict) or preparation["rights"].get("audioDistributionAllowed") is not True:
        raise PreparationError("The preparation record does not confirm this edition's audio distribution permission.")
    chapters = manifest.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise PreparationError("The manifest contains no completed chapters.")
    seen = set()
    plan = []
    for chapter in chapters:
        if not isinstance(chapter, dict) or type(chapter.get("chapterIndex")) is not int or chapter["chapterIndex"] < 0:
            raise PreparationError("The manifest contains an invalid chapter index.")
        index = chapter["chapterIndex"]
        if index in seen:
            raise PreparationError("The manifest repeats a chapter index.")
        seen.add(index)
        extension = "opus" if word_audio else "mp3"
        expected_path = "/".join((book_id, edition_id, narrator_id, generation_id, f"chapter-{index + 1:04d}.{extension}"))
        if chapter.get("audioPath") != expected_path:
            raise PreparationError("An audio path does not match the declared book, edition and generation.")
        local_path = child_path(output_root, *expected_path.split("/"))
        if not local_path.is_file() or not local_path.stat().st_size:
            raise PreparationError("A chapter audio file is missing or empty.")
        digest = file_digest(local_path)
        if chapter.get("audioSha256") != digest:
            raise PreparationError("A chapter audio file has changed since its manifest was generated. Generate it again before uploading.")
        if word_audio and chapter.get("byteLength") != local_path.stat().st_size:
            raise PreparationError("A chapter byte length differs from its manifest.")
        plan.append((local_path, expected_path, digest))
    coverage = manifest.get("coverage", {})
    if not isinstance(coverage, dict) or coverage.get("chapterIndices") != sorted(seen) or type(coverage.get("totalChapters")) is not int or not 1 <= coverage["totalChapters"] or max(seen) >= coverage["totalChapters"]:
        raise PreparationError("The manifest chapter coverage is invalid.")
    if coverage.get("complete") is not (sorted(seen) == list(range(coverage["totalChapters"]))):
        raise PreparationError("The manifest incorrectly labels its chapter coverage.")
    if word_audio:
        validate_word_assets(manifest, generation_base)
    return manifest, plan, generation_base


def validate_word_assets(manifest: dict, generation_base: Path) -> None:
    """Check the real canonical EPUB and every exact word range before upload."""
    import zipfile
    import xml.etree.ElementTree as ET
    from .locations import canonical_cfi, source_words
    from .core import digest_text
    from .word_pipeline import valid_words
    canonical = manifest.get("canonicalEpub", {})
    prefix = "/".join((manifest["bookId"], manifest["editionId"], manifest["narrator"]["id"], manifest["generationId"]))
    path = generation_base / "canonical.epub"
    if not isinstance(canonical, dict) or canonical.get("path") != prefix + "/canonical.epub" or not path.is_file() or canonical.get("sha256") != file_digest(path):
        raise PreparationError("The exact canonical EPUB is missing or changed. Its CFI mapping cannot be verified.")
    ns = {"x": "http://www.w3.org/1999/xhtml"}
    try:
        with zipfile.ZipFile(path) as archive:
            for chapter in manifest["chapters"]:
                index = chapter["chapterIndex"]
                document = ET.fromstring(archive.read(f"EPUB/chapter-{index + 1}.xhtml"))
                body = document.find("x:body", ns)
                if body is None or any(element.tag != "{" + ns["x"] + "}p" or len(element) for element in body):
                    raise PreparationError("The canonical EPUB no longer has one source text node per paragraph.")
                paragraphs = [element.text or "" for element in body]
                if len(chapter.get("segments", [])) != len(paragraphs):
                    raise PreparationError("Paragraph cues do not match the canonical EPUB.")
                all_words = chapter.get("words", [])
                previous_end = 0.0
                for paragraph_index, text in enumerate(paragraphs):
                    segment = chapter["segments"][paragraph_index]
                    if segment.get("paragraphIndex") != paragraph_index or segment.get("textHash") != digest_text(text):
                        raise PreparationError("A paragraph hash differs from the canonical EPUB.")
                    words = [word for word in all_words if word.get("paragraphIndex") == paragraph_index]
                    if not valid_words(words, source_words(text), chapter["durationSeconds"]):
                        raise PreparationError("Word timings do not cover the canonical source words exactly.")
                    for word in words:
                        if word.get("cfi") != canonical_cfi(index, paragraph_index, word["charStart"]) or word["startSeconds"] < previous_end:
                            raise PreparationError("A word CFI or monotonic audio timestamp is invalid.")
                        previous_end = word["endSeconds"]
                if len(all_words) != sum(len(source_words(text)) for text in paragraphs):
                    raise PreparationError("The manifest contains extra or missing source word cues.")
    except (zipfile.BadZipFile, ET.ParseError, KeyError, TypeError, ValueError, OSError) as error:
        raise PreparationError("The canonical EPUB or word timing data could not be verified.") from error
