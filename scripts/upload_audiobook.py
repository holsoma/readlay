#!/usr/bin/env python3
"""Upload prepared Opus or legacy MP3 assets to private Supabase Storage."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from audio.core import PreparationError, atomic_json, file_digest
from audio.upload import SupabaseStorage, upload_plan

ROOT = Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output-root", type=Path, default=ROOT / ".local" / "audiobooks")
    parser.add_argument("--create-bucket", action="store_true", help="Create the named bucket as private if it does not exist")
    parser.add_argument("--allow-partial", action="store_true", help="Upload only explicitly prepared chapters; the manifest keeps incomplete coverage")
    parser.add_argument("--dry-run", action="store_true", help="Validate local files without reading credentials or contacting storage")
    args = parser.parse_args(argv)
    try:
        initial_manifest_hash = hashlib.sha256(args.manifest.read_bytes()).hexdigest()
        manifest, plan, generation_base = upload_plan(args.manifest, args.output_root)
        if file_digest(args.manifest) != initial_manifest_hash:
            raise PreparationError("The local manifest changed while it was being checked. Run the command again.")
        if not manifest["coverage"]["complete"] and not args.allow_partial:
            raise PreparationError("This audiobook is incomplete. Finish the remaining chapters or use --allow-partial for a deliberate preview.")
        print(f"Validated {len(plan)} chapter audio files ({sum(path.stat().st_size for path, _, _ in plan):,} bytes).")
        if args.dry_run:
            print("Dry run complete. No credentials read and no network requests made.")
            return 0
        storage = SupabaseStorage(os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""), os.environ.get("AUDIO_STORAGE_BUCKET", "readlay-audio"))
        opus = manifest.get("schemaVersion") == 2
        content_type = "audio/ogg" if opus else "audio/mpeg"
        storage.require_private_bucket(args.create_bucket, (content_type, "application/json"))
        for index, (path, object_path, digest) in enumerate(plan):
            print(f"Uploading chapter {index + 1}/{len(plan)} ({path.stat().st_size:,} bytes).", flush=True)
            if file_digest(path) != digest:
                raise PreparationError("A chapter audio file changed after validation. Run the command again before deploying.")
            if opus:
                storage.upload(path, object_path, digest, generation_base / ".upload-state.json", content_type)
            else:
                storage.upload(path, object_path, digest, generation_base / ".upload-state.json")
            if file_digest(path) != digest:
                raise PreparationError("A chapter audio file changed during upload. The manifest was not activated.")
            if not storage._existing_matches(object_path, digest):
                raise PreparationError("Storage did not return the uploaded chapter for SHA256 verification. The manifest was not activated.")
        manifest_hash = initial_manifest_hash
        if file_digest(args.manifest) != manifest_hash:
            raise PreparationError("The local manifest changed during upload. Run the command again before deploying it.")
        remote_manifest = "/".join((manifest["bookId"], manifest["editionId"], manifest["narrator"]["id"], manifest["generationId"], f"manifest-{manifest_hash}.json"))
        storage.upload(args.manifest, remote_manifest, manifest_hash, generation_base / ".upload-state.json", "application/json")
        if not storage._existing_matches(remote_manifest, manifest_hash):
            raise PreparationError("Storage did not return the uploaded manifest for SHA256 verification. It was not activated.")
        # Do not activate a manifest that was changed by another preparation process mid-upload.
        if file_digest(args.manifest) != manifest_hash:
            raise PreparationError("The local manifest changed during upload. Run the command again before deploying it.")
        uploaded_at = datetime.now(timezone.utc).isoformat()
        atomic_json(generation_base / "upload-receipt.json", {"manifestSha256": manifest_hash, "generationId": manifest["generationId"], "bucket": storage.bucket, "origin": storage.url, "uploadedAt": uploaded_at, "remoteManifestPath": remote_manifest, "objects": [{"audioPath": object_path, "sha256": digest} for _, object_path, digest in plan]})
        atomic_json(args.manifest.parent / "published.json", {"generationId": manifest["generationId"], "manifestHash": manifest_hash, "storageOrigin": storage.url, "bucket": storage.bucket, "uploadedAtISO": uploaded_at})
        print("Upload complete. Deploy the matching local manifest.json and published.json with Readlay to make these chapters available.")
        return 0
    except (PreparationError, OSError) as error:
        print(f"Upload stopped: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Upload interrupted. Completed objects are kept. Run the command again to resume.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
