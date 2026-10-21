#!/usr/bin/env python3
"""Optional private EPUB/PDF source upload, with server-authorised R2 quotas."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from audio.core import PreparationError, file_digest, identifier


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--rights-confirmed", action="store_true")
    parser.add_argument("--private-bucket-confirmed", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        book = identifier(args.book, "book")
        if not args.rights_confirmed:
            raise PreparationError("Confirm permission to store and distribute this edition with --rights-confirmed.")
        suffix = args.source.suffix.lower()
        if suffix not in (".epub", ".pdf") or not args.source.is_file() or not args.source.stat().st_size:
            raise PreparationError("Choose a non-empty EPUB or PDF source.")
        digest = file_digest(args.source)
        key = f"ebooks/{book}/{digest}/source{suffix}"
        if args.dry_run:
            print("Source validated. No credentials read and no network requests made.")
            return 0
        from audio.r2_storage import R2Storage
        storage = R2Storage(os.environ.get("R2_ACCOUNT_ID", ""), os.environ.get("R2_ACCESS_KEY_ID", ""),
                            os.environ.get("R2_SECRET_ACCESS_KEY", ""), os.environ.get("R2_AUDIO_BUCKET", "readlay-audio"), args.private_bucket_confirmed)
        storage.require_private_bucket()
        storage.upload(args.source, key, digest, args.source.parent / ".unused-r2-state", "application/epub+zip" if suffix == ".epub" else "application/pdf")
        if not storage._existing_matches(key, digest):
            raise PreparationError("The stored source could not be verified.")
        print(f"Verified private source upload: {book}. The website catalogue was not changed.")
        return 0
    except (PreparationError, OSError) as error:
        print(f"Upload stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
