#!/usr/bin/env python3
"""Prepare a resumable local catalogue batch without changing published audio."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import sys
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from audio.core import PreparationError, atomic_json, canonical_json, child_path, file_digest, identifier, read_book, select_chapters
from audio.locations import load_reader_corrections
from generate_audiobook import arguments as generation_arguments, generate

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VOICES = ("af_heart", "am_michael")


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("book_ids", nargs="*", help="Book IDs; omit to discover the JSON books in --books-dir")
    parser.add_argument("--books-dir", type=Path, default=ROOT / ".local" / "books")
    parser.add_argument("--voices", nargs="+", default=list(DEFAULT_VOICES), help="English Kokoro voices; defaults to af_heart am_michael")
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    parser.add_argument("--rights-confirmed", action="store_true", required=True, help="Confirm permission to prepare and distribute audio for every selected source edition")
    parser.add_argument("--output-root", type=Path, default=ROOT / ".local" / "audiobook-batch-output", help="Unpublished staging tree; the website's active .local/audiobooks tree is rejected")
    parser.add_argument("--cache-root", type=Path, default=ROOT / ".local" / "audio-cache")
    parser.add_argument("--chapters", help="Optional one-based selection applied to each book, for example 1,3-5")
    parser.add_argument("--max-chars", type=int, default=350)
    parser.add_argument("--paragraph-gap-ms", type=int, default=300)
    parser.add_argument("--bitrate", choices=("24k", "32k", "48k", "64k", "80k", "96k", "128k"), default="24k")
    parser.add_argument("--model-revision", default="main")
    parser.add_argument("--allow-download", action="store_true", help="Permit a one-off model/voice download; narration never uses an online speech API")
    parser.add_argument("--dry-run", action="store_true", help="List work without loading models, creating files or generating audio")
    return parser.parse_args(argv)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_staging_root(output_root: Path) -> Path:
    output_root = output_root.resolve()
    active = (ROOT / ".local" / "audiobooks").resolve()
    if output_root == active or output_root.is_relative_to(active) or active.is_relative_to(output_root):
        raise PreparationError("Use a separate unpublished output root. Catalogue batches cannot write in, above or below the website's active audiobook tree.")
    if output_root.exists() and next(output_root.rglob("published.json"), None) is not None:
        raise PreparationError("The selected output tree contains a published receipt. Choose a separate unpublished staging folder.")
    return output_root


@contextlib.contextmanager
def exclusive_batch_lock(path: Path):
    """Operating-system locks release on interruption or a killed process."""
    with path.open("a+b") as handle:
        if path.stat().st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise PreparationError("Another catalogue batch is using this staging folder. Resume it after that process finishes.") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class WarmEngines:
    """One provider per selected voice and one aligner for this serial batch."""
    def __init__(self, provider_factory=None, aligner_factory=None):
        self.provider_factory = provider_factory
        self.aligner_factory = aligner_factory
        self.providers, self.aligners, self.failures = {}, {}, {}

    def provider(self, *settings):
        key = ("provider", *settings)
        if key in self.failures:
            raise PreparationError("The selected narrator failed model setup earlier in this batch. See its first private error log.") from None
        if key not in self.providers:
            try:
                if self.provider_factory is None:
                    from audio.kokoro_provider import KokoroProvider
                    self.provider_factory = KokoroProvider
                self.providers[key] = self.provider_factory(*settings)
            except Exception as error:
                self.failures[key] = type(error).__name__
                raise
        return self.providers[key]

    def aligner(self, *settings):
        key = ("aligner", *settings)
        if key in self.failures:
            raise PreparationError("The acoustic model failed setup earlier in this batch. See its first private error log.") from None
        if key not in self.aligners:
            try:
                if self.aligner_factory is None:
                    from audio.word_alignment import Wav2Vec2Aligner
                    self.aligner_factory = Wav2Vec2Aligner
                self.aligners[key] = self.aligner_factory(*settings)
            except Exception as error:
                self.failures[key] = type(error).__name__
                raise
        return self.aligners[key]


def source_mapping_hash(path: Path, book_id: str, book: dict) -> str:
    manifest = path.parent.parent / "reader" / (book_id + ".json") if path.parent.name == "books" else None
    changes = load_reader_corrections(book, book_id, manifest if manifest and manifest.exists() else None)
    mapped = [{"chapterIndex": chapter, "paragraphIndex": paragraph, **change}
              for (chapter, paragraph), values in sorted(changes.items()) for change in values]
    return hashlib.sha256(canonical_json(mapped)).hexdigest()


def plan_batch(args: argparse.Namespace) -> tuple[list[dict], list[dict]]:
    if not args.rights_confirmed:
        raise PreparationError("Confirm audio preparation and distribution rights for every selected book with --rights-confirmed.")
    if not 80 <= args.max_chars <= 1000 or not 0 <= args.paragraph_gap_ms <= 2000:
        raise PreparationError("Use --max-chars between 80 and 1000 and --paragraph-gap-ms between 0 and 2000.")
    args.voices = list(dict.fromkeys(args.voices))
    if not args.voices or any(not re.fullmatch(r"[ab][fm]_[a-z0-9_]+", voice) for voice in args.voices):
        raise PreparationError("Select English Kokoro voices such as af_heart and am_michael.")
    book_ids = list(dict.fromkeys(args.book_ids)) if args.book_ids else sorted(path.stem for path in args.books_dir.glob("*.json") if path.is_file())
    if not book_ids:
        raise PreparationError("No structured source books were selected or found.")
    books = []
    for book_id in book_ids:
        identifier(book_id, "bookId")
        path = child_path(args.books_dir, book_id + ".json")
        book = read_book(path)
        books.append({"bookId": book_id, "input": path, "book": book, "sourceSha256": file_digest(path),
                      "sourceMappingSha256": source_mapping_hash(path, book_id, book),
                      "chapters": select_chapters(args.chapters, len(book["chapters"]))})
    # Start each book and voice before moving to the next chapter ordinal.
    tasks = []
    for ordinal in range(max(len(book["chapters"]) for book in books)):
        for book in books:
            if ordinal >= len(book["chapters"]):
                continue
            chapter_index = book["chapters"][ordinal]
            for voice in args.voices:
                tasks.append({"book": book, "voice": voice, "chapterIndex": chapter_index,
                              "key": "/".join((book["bookId"], book["book"]["editionId"], voice, str(chapter_index)))})
    return books, tasks


def chapter_arguments(args: argparse.Namespace, task: dict) -> argparse.Namespace:
    voice = task["voice"]
    gender = "Female" if voice[1] == "f" else "Male"
    options = [str(task["book"]["input"]), "--book-id", task["book"]["bookId"], "--voice", voice,
               "--narrator-name", f"{gender} voice", "--device", args.device, "--chapters", str(task["chapterIndex"] + 1),
               "--rights-confirmed", "--output-root", str(args.output_root), "--cache-root", str(args.cache_root),
               "--max-chars", str(args.max_chars), "--paragraph-gap-ms", str(args.paragraph_gap_ms),
               "--bitrate", args.bitrate, "--model-revision", args.model_revision]
    if args.allow_download:
        options.append("--allow-download")
    return generation_arguments(options)


def private_error_context(task: dict, error: Exception, max_chars: int) -> dict:
    """Detailed source context belongs only in the ignored preparation tree."""
    context = {"errorType": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
    match = re.search(r"Chapter (\d+), paragraph (\d+)(?:, sentence chunk (\d+))?", str(error))
    if not match:
        return context
    chapter_index, paragraph_index = int(match[1]) - 1, int(match[2]) - 1
    chapters = task["book"]["book"]["chapters"]
    if not 0 <= chapter_index < len(chapters) or not 0 <= paragraph_index < len(chapters[chapter_index]["paragraphs"]):
        return context
    source = chapters[chapter_index]["paragraphs"][paragraph_index]
    context.update({"chapterIndex": chapter_index, "paragraphIndex": paragraph_index, "sourceParagraph": source})
    if match[3]:
        from audio.word_pipeline import sentence_chunks
        chunk_index = int(match[3]) - 1
        chunks = sentence_chunks(source, max_chars)
        if 0 <= chunk_index < len(chunks):
            start, end = chunks[chunk_index]
            context.update({"sentenceChunkIndex": chunk_index, "sourcePythonStart": start, "sourcePythonEnd": end,
                            "sourceSentence": source[start:end]})
    return context


def read_previous_report(path: Path) -> dict:
    try:
        if path.stat().st_size > 32 * 1024 * 1024:
            return {}
        previous = json.loads(path.read_text(encoding="utf-8"))
        return previous.get("results", {}) if isinstance(previous, dict) and isinstance(previous.get("results"), dict) else {}
    except (OSError, UnicodeError, ValueError):
        return {}


def run_batch(args: argparse.Namespace, generate_function=None, provider_factory=None, aligner_factory=None) -> int:
    args.output_root = ensure_staging_root(args.output_root)
    books, tasks = plan_batch(args)
    print(f"Catalogue batch: {len(books)} books, {len(args.voices)} voices, {len(tasks)} chapter attempts; device {args.device}.", flush=True)
    if args.dry_run:
        print("Dry run complete. No models, narration, network access or output files.", flush=True)
        return 0
    args.output_root.mkdir(parents=True, exist_ok=True)
    with exclusive_batch_lock(args.output_root / ".batch.lock"):
        report_path = args.output_root / "batch-progress.json"
        previous = read_previous_report(report_path)
        state = {"schemaVersion": 1, "runId": uuid.uuid4().hex, "status": "running", "startedAt": timestamp(), "updatedAt": timestamp(),
                 "outputRoot": str(args.output_root), "cacheRoot": str(args.cache_root.resolve()), "rightsConfirmed": True,
                 "voices": [{"voice": voice, "gender": "female" if voice[1] == "f" else "male"} for voice in args.voices],
                 "settings": {"device": args.device, "maxChars": args.max_chars, "paragraphGapMs": args.paragraph_gap_ms,
                              "bitrate": args.bitrate, "modelRevision": args.model_revision, "allowDownload": args.allow_download},
                 "books": [{"bookId": item["bookId"], "editionId": item["book"]["editionId"], "sourceSha256": item["sourceSha256"],
                            "sourceMappingSha256": item["sourceMappingSha256"],
                            "selectedChapterIndices": item["chapters"], "totalChapters": len(item["book"]["chapters"])} for item in books],
                 "current": None, "results": {}}
        for task in tasks:
            prior = previous.get(task["key"], {})
            attempts = prior.get("attempts", 0) if isinstance(prior, dict) else 0
            state["results"][task["key"]] = {"bookId": task["book"]["bookId"], "editionId": task["book"]["book"]["editionId"],
                "voice": task["voice"], "chapterIndex": task["chapterIndex"], "status": "pending",
                "attempts": attempts if type(attempts) is int and attempts >= 0 else 0}

        def checkpoint():
            state["updatedAt"] = timestamp()
            statuses = [item["status"] for item in state["results"].values()]
            state["counts"] = {"total": len(tasks), **{name: statuses.count(name) for name in ("pending", "running", "succeeded", "failed", "interrupted")}}
            atomic_json(report_path, state)

        engines = WarmEngines(provider_factory, aligner_factory)
        generator = generate_function or generate
        try:
            checkpoint()
            for ordinal, task in enumerate(tasks, 1):
                result = state["results"][task["key"]]
                result.update({"status": "running", "attempts": result["attempts"] + 1, "startedAt": timestamp()})
                state["current"] = task["key"]
                checkpoint()
                book_id, voice, chapter_index = result["bookId"], result["voice"], result["chapterIndex"]
                print(f"[{ordinal}/{len(tasks)}] {book_id}; {voice}; chapter {chapter_index + 1}.", flush=True)
                relative = (book_id, result["editionId"], voice, f"chapter-{chapter_index + 1:04d}")
                log_path = child_path(args.output_root, "batch-logs", *relative[:-1], relative[-1] + ".log")
                log_path.parent.mkdir(parents=True, exist_ok=True)
                result["logPath"] = str(log_path)
                try:
                    source = task["book"]
                    if file_digest(source["input"]) != source["sourceSha256"] or source_mapping_hash(source["input"], book_id, source["book"]) != source["sourceMappingSha256"]:
                        raise PreparationError("The source edition or reviewed spoken corrections changed during this batch. Resume with a new plan before preparing this book.")
                    destination = child_path(args.output_root, book_id, result["editionId"], f"kokoro-{voice}")
                    if (destination / "published.json").exists():
                        raise PreparationError("This narrator was published while the batch was running. Its active manifest has been preserved.")
                    with log_path.open("a", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                        print(f"\nBatch run {state['runId']}, attempt {result['attempts']}, {timestamp()}", flush=True)
                        manifest_path = generator(chapter_arguments(args, task), engines.provider, engines.aligner)
                    if manifest_path is None or not manifest_path.resolve().is_relative_to(args.output_root):
                        raise PreparationError("The generation command did not return a staged manifest.")
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    chapter = next((item for item in manifest.get("chapters", []) if item.get("chapterIndex") == chapter_index), None)
                    if chapter is None:
                        raise PreparationError("The prepared manifest does not cover the requested chapter.")
                    result.update({"status": "succeeded", "finishedAt": timestamp(), "manifestPath": str(manifest_path),
                                   "generationId": manifest["generationId"], "byteLength": chapter["byteLength"],
                                   "durationSeconds": chapter["durationSeconds"], "wordCues": len(chapter["words"])})
                    print(f"Ready: {book_id}; {voice}; chapter {chapter_index + 1}; {chapter['byteLength']:,} bytes.", flush=True)
                except KeyboardInterrupt:
                    result.update({"status": "interrupted", "finishedAt": timestamp()})
                    raise
                except Exception as error:
                    error_path = log_path.with_suffix(".error.json")
                    details = {key: result[key] for key in ("bookId", "editionId", "voice", "chapterIndex", "attempts")}
                    details.update({"failedAt": timestamp(), **private_error_context(task, error, args.max_chars)})
                    atomic_json(error_path, details)
                    result.update({"status": "failed", "finishedAt": timestamp(), "errorReportPath": str(error_path)})
                    print(f"Failed: {book_id}; {voice}; chapter {chapter_index + 1}. Details are in the private batch report.", flush=True)
                state["current"] = None
                checkpoint()
        except KeyboardInterrupt:
            if state["current"] is not None and state["results"][state["current"]]["status"] == "running":
                state["results"][state["current"]].update({"status": "interrupted", "finishedAt": timestamp()})
            state["status"] = "interrupted"
            state["finishedAt"] = timestamp()
            checkpoint()
            print("Batch interrupted. Verified chapter files, sentence caches and the checkpoint are retained. Run the same command to resume.", flush=True)
            return 130
        state["status"] = "completed_with_errors" if any(item["status"] == "failed" for item in state["results"].values()) else "completed"
        state["finishedAt"] = timestamp()
        checkpoint()
        print(f"Batch finished: {state['counts']['succeeded']} ready; {state['counts']['failed']} failed. No files were uploaded or activated.", flush=True)
        return 1 if state["counts"]["failed"] else 0


def main(argv: list[str] | None = None) -> int:
    try:
        return run_batch(arguments(argv))
    except (PreparationError, OSError) as error:
        # Setup messages contain paths/IDs only. Chapter exception contents are
        # deliberately restricted to private logs by run_batch.
        print(f"Batch could not start: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Batch interrupted before generation started.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
