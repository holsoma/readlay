#!/usr/bin/env python3
"""Prepare paragraph-aligned audiobooks locally. No website service uses Python."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from audio.core import (
    PIPELINE_VERSION, SAMPLE_RATE, PreparationError, atomic_json, cache_paragraph,
    canonical_json, child_path, digest_text, encode_chapter, file_digest, identifier,
    read_book, require_encoder, select_chapters, split_paragraph, text_book,
)

ROOT = Path(__file__).resolve().parents[1]


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Imported structured JSON or UTF-8 .txt with blank lines between paragraphs")
    parser.add_argument("--book-id", required=True)
    parser.add_argument("--edition-id", help="For plain-text input only; defaults to its SHA256 prefix")
    parser.add_argument("--title", help="Chapter title for plain-text input")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--language", choices=("a", "b"), help="a: American English; b: British English. Inferred from the voice by default")
    parser.add_argument("--narrator-id", help="Defaults to kokoro-<voice>")
    parser.add_argument("--narrator-name", help="Display name; defaults to the voice name")
    parser.add_argument("--model-revision", default="main", help="Hugging Face model revision or commit; actual asset hashes are recorded")
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    parser.add_argument("--chapters", help="One-based chapter selection, for example 1,3-5; partial coverage is recorded")
    parser.add_argument("--max-chars", type=int, default=350, help="Maximum characters per model call inside a paragraph")
    parser.add_argument("--paragraph-gap-ms", type=int, default=300)
    parser.add_argument("--bitrate", choices=("48k", "64k", "80k", "96k", "128k"), default="64k")
    parser.add_argument("--output-root", type=Path, default=ROOT / ".local" / "audiobooks")
    parser.add_argument("--cache-root", type=Path, default=ROOT / ".local" / "audio-cache")
    parser.add_argument("--rights-confirmed", action="store_true", help="Record that you have permission to prepare and distribute this edition's audio")
    parser.add_argument("--rights-file", type=Path, help="JSON {bookId,editionId,audioDistributionAllowed:true}; stored locally only")
    parser.add_argument("--allow-download", action="store_true", help="One-off model setup; default generation uses only cached models")
    parser.add_argument("--dry-run", action="store_true", help="Inspect input and chunk counts without dependencies, writes or network")
    return parser.parse_args(argv)


def rights_record(args: argparse.Namespace, book: dict) -> dict:
    if args.rights_file:
        try:
            record = json.loads(args.rights_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise PreparationError("The rights file must be readable JSON.") from error
        if not isinstance(record, dict) or record.get("bookId") != args.book_id or record.get("editionId") != book["editionId"] or record.get("audioDistributionAllowed") is not True:
            raise PreparationError("The rights file must grant audio distribution for this exact book and edition.")
        return {"audioDistributionAllowed": True, "basis": "rights-file", "recordHash": file_digest(args.rights_file)}
    if not args.rights_confirmed:
        raise PreparationError("Record the existing permission with --rights-confirmed or a matching --rights-file before generating audio.")
    return {"audioDistributionAllowed": True, "basis": "operator-confirmation"}


def generate(args: argparse.Namespace, provider_factory=None) -> Path | None:
    identifier(args.book_id, "bookId")
    if not re.fullmatch(r"[ab][fm]_[a-z0-9_]+", args.voice):
        raise PreparationError("Use an English Kokoro voice ID such as af_heart, bf_emma or bm_george.")
    language = args.language or args.voice[0]
    if args.voice[0] != language:
        raise PreparationError("The voice and language must agree: a for American English or b for British English.")
    narrator_id = identifier(args.narrator_id or f"kokoro-{args.voice}", "narratorId")
    if args.narrator_name is not None and (not args.narrator_name.strip() or len(args.narrator_name) > 120):
        raise PreparationError("The narrator name must contain 1 to 120 characters.")
    if not 0 <= args.paragraph_gap_ms <= 2000:
        raise PreparationError("The paragraph gap must be between 0 and 2000 milliseconds.")
    if not 80 <= args.max_chars <= 1000:
        raise PreparationError("The chunk limit must be between 80 and 1000 characters.")
    book = text_book(args.input, args.edition_id, args.title) if args.input.suffix.lower() == ".txt" else read_book(args.input)
    if args.input.suffix.lower() != ".txt" and (args.edition_id or args.title):
        raise PreparationError("--edition-id and --title apply only to plain-text input. Structured book data supplies both.")
    selected = select_chapters(args.chapters, len(book["chapters"]))
    paragraph_count = sum(len(book["chapters"][index]["paragraphs"]) for index in selected)
    chunk_count = sum(len(split_paragraph(text, args.max_chars)) for index in selected for text in book["chapters"][index]["paragraphs"])
    print(f"Book {args.book_id}; edition {book['editionId']}; voice {args.voice}.", flush=True)
    print(f"Selected {len(selected)}/{len(book['chapters'])} chapters, {paragraph_count} paragraphs, {chunk_count} text chunks.", flush=True)
    if args.dry_run:
        print("Dry run complete. No files written, dependencies loaded, models downloaded or audio generated.")
        return None
    rights = rights_record(args, book)
    ffmpeg, ffprobe = require_encoder()
    if provider_factory is None:
        from audio.kokoro_provider import KokoroProvider
        provider_factory = KokoroProvider
    provider = provider_factory(args.voice, language, args.model_revision, args.allow_download, args.device)
    config = {
        "pipeline": PIPELINE_VERSION, "provider": provider.fingerprint,
        "maxChars": args.max_chars, "paragraphGapMs": args.paragraph_gap_ms,
        "bitrate": args.bitrate, "sampleRate": SAMPLE_RATE,
        "sourceHash": hashlib.sha256(canonical_json(book)).hexdigest(),
    }
    try:
        encoder_version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=False, timeout=15)
    except subprocess.TimeoutExpired as error:
        raise PreparationError("ffmpeg did not respond to its version check within 15 seconds.") from error
    if encoder_version.returncode or not encoder_version.stdout:
        raise PreparationError("ffmpeg could not report its version.")
    config["encoderVersion"] = encoder_version.stdout.splitlines()[0]
    generation_id = hashlib.sha256(canonical_json(config)).hexdigest()[:24]
    base = child_path(args.output_root, args.book_id, book["editionId"], narrator_id)
    manifest_path = child_path(base, "manifest.json")
    generation_base = child_path(base, generation_id)
    generation_base.mkdir(parents=True, exist_ok=True)
    previous = None
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    chapters_by_index = {}
    if isinstance(previous, dict) and previous.get("generationId") == generation_id:
        for chapter in previous.get("chapters", []):
            if isinstance(chapter, dict) and isinstance(chapter.get("chapterIndex"), int):
                chapters_by_index[chapter["chapterIndex"]] = chapter
    manifest = {
        "schemaVersion": 1, "bookId": args.book_id, "editionId": book["editionId"],
        "generationId": generation_id,
        "narrator": {"id": narrator_id, "name": args.narrator_name or args.voice.replace("_", " ").title(), "engine": "kokoro", "voice": args.voice, "language": "en-US" if language == "a" else "en-GB"},
        "alignment": "paragraph", "sampleRate": SAMPLE_RATE,
        "coverage": {"complete": False, "totalChapters": len(book["chapters"]), "chapterIndices": []},
        "chapters": [],
    }
    preparation = {"bookId": args.book_id, "editionId": book["editionId"], "generationId": generation_id, "rights": rights, "configuration": config, "preparedAt": datetime.now(timezone.utc).isoformat()}
    atomic_json(generation_base / "preparation.json", preparation)
    gap_samples = round(args.paragraph_gap_ms * SAMPLE_RATE / 1000)
    started = time.monotonic()
    for chapter_index in selected:
        chapter = book["chapters"][chapter_index]
        print(f"Preparing chapter {chapter_index + 1}/{len(book['chapters'])} ({len(chapter['paragraphs'])} paragraphs).", flush=True)
        cached = [cache_paragraph(text, provider, args.cache_root, args.max_chars) for text in chapter["paragraphs"]]
        chapter_name = f"chapter-{chapter_index + 1:04d}.mp3"
        audio_file = child_path(generation_base, chapter_name)
        intervals, frames, encoded_duration = encode_chapter(cached, audio_file, gap_samples, ffmpeg, ffprobe, args.bitrate)
        audio_path = "/".join((args.book_id, book["editionId"], narrator_id, generation_id, chapter_name))
        chapters_by_index[chapter_index] = {
            "chapterIndex": chapter_index, "chapterId": chapter["id"], "title": chapter["title"],
            "audioPath": audio_path, "durationSeconds": frames / SAMPLE_RATE,
            "encodedDurationSeconds": encoded_duration, "audioSha256": file_digest(audio_file),
            "segments": [{"paragraphIndex": index, "startSeconds": start / SAMPLE_RATE, "endSeconds": end / SAMPLE_RATE, "startSample": start, "endSample": end, "textHash": digest_text(text)} for index, (text, (start, end)) in enumerate(zip(chapter["paragraphs"], intervals))],
        }
        # An interrupted run retains only fully encoded chapters. Same settings merge coverage.
        manifest["chapters"] = [chapters_by_index[index] for index in sorted(chapters_by_index)]
        coverage = manifest["coverage"]
        coverage["chapterIndices"] = sorted(chapters_by_index)
        coverage["complete"] = coverage["chapterIndices"] == list(range(len(book["chapters"])))
        atomic_json(manifest_path, manifest)
        atomic_json(generation_base / "manifest.json", manifest)
        print(f"Chapter ready: {frames / SAMPLE_RATE:.2f}s; {audio_file.stat().st_size:,} bytes.", flush=True)
    print(f"Finished in {time.monotonic() - started:.1f}s. Manifest: {manifest_path}")
    return manifest_path


def main(argv: list[str] | None = None) -> int:
    try:
        generate(arguments(argv))
        return 0
    except (PreparationError, OSError) as error:
        print(f"Preparation stopped: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Preparation interrupted. Completed paragraph caches and chapters are kept for the next run.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
