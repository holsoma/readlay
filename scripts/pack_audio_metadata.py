#!/usr/bin/env python3
"""Losslessly compress verified published manifests before a website build."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def pack(directory: Path) -> tuple[int, int]:
    source = directory / "manifest.json"
    if source.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("A manifest exceeds the website's bounded decompression limit.")
    content = source.read_bytes()
    if len(content) > 64 * 1024 * 1024:
        raise ValueError("A manifest exceeds the website's bounded decompression limit.")
    receipt = json.loads((directory / "published.json").read_text(encoding="utf-8"))
    manifest = json.loads(content)
    if not isinstance(receipt, dict) or not isinstance(manifest, dict) or not isinstance(manifest.get("generationId"), str) or not re.fullmatch(r"[a-f0-9]{24}", manifest["generationId"]) or receipt.get("manifestHash") != hashlib.sha256(content).hexdigest() or receipt.get("generationId") != manifest["generationId"]:
        raise ValueError("A publication receipt does not match its manifest. Upload and verify it before packing.")
    compressed = gzip.compress(content, compresslevel=9, mtime=0)
    if gzip.decompress(compressed) != content:
        raise ValueError("Lossless metadata verification failed.")
    with tempfile.NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(compressed)
    try:
        temporary.replace(directory / "manifest.json.gz")
    finally:
        temporary.unlink(missing_ok=True)
    return len(content), len(compressed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT / ".local" / "audiobooks")
    args = parser.parse_args()
    counts = [pack(receipt.parent) for receipt in sorted(args.root.glob("*/*/*/published.json"))]
    print(f"Packed {len(counts)} verified manifests: {sum(item[0] for item in counts):,} bytes to {sum(item[1] for item in counts):,} bytes. Source bytes and publication hashes are unchanged.")


if __name__ == "__main__":
    main()
