"""Sentence-cached narration, acoustic word alignment and chapter Opus assets."""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import re
import subprocess
import tempfile
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

from .core import SAMPLE_RATE, PreparationError, atomic_json, canonical_json, child_path, digest_text, file_digest, probe_duration, read_book, require_encoder, select_chapters, text_book
from .locations import LOCATION_SCHEME, canonical_cfi, source_words, utf16_offset, write_canonical_epub
from .word_alignment import MINIMUM_MEAN_CONFIDENCE, MINIMUM_WORD_CONFIDENCE, spoken_sentence

PIPELINE_VERSION = "readlay-word-audio-v2.5"
MINIMUM_SENTENCE_CONTEXT = 40
SENTENCE_BOUNDARY_VERSION = 2


def sentence_chunks(text: str, max_chars: int) -> list[tuple[int, int]]:
    """Original Python offsets; no whitespace normalisation or word truncation."""
    result = []
    start = 0
    boundaries = []
    for match in re.finditer(r"[.!?]+[\"'”’)]*(?:\s+|$)", text):
        if text[match.start()] == ".":
            preceding = re.search(r"([A-Za-z]+)$", text[:match.start()])
            if preceding and (len(preceding.group(1)) == 1 or preceding.group(1).lower() in {"mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc"}):
                continue
        boundaries.append(match.end())
    boundaries.append(len(text))
    for end in sorted(set(boundaries)):
        while start < end:
            while start < end and text[start].isspace():
                start += 1
            if start >= end:
                break
            cut = end
            if end - start > max_chars:
                safe = [match.start() for match in re.finditer(r"\s+", text[start:start + max_chars + 1])]
                if not safe:
                    raise PreparationError("An unbroken source word exceeds --max-chars. Correct the source or raise the limit before preparing audio.")
                cut = start + safe[-1]
            trimmed = cut
            while trimmed > start and text[trimmed - 1].isspace():
                trimmed -= 1
            if trimmed > start:
                result.append((start, trimmed))
            start = cut
    grouped = []
    for start, end in result:
        if grouped and grouped[-1][1] - grouped[-1][0] < MINIMUM_SENTENCE_CONTEXT and end - grouped[-1][0] <= max_chars:
            grouped[-1] = grouped[-1][0], end
        else:
            grouped.append((start, end))
    if len(grouped) > 1 and grouped[-1][1] - grouped[-1][0] < MINIMUM_SENTENCE_CONTEXT and grouped[-1][1] - grouped[-2][0] <= max_chars:
        grouped[-2:] = [(grouped[-2][0], grouped[-1][1])]
    return grouped


def cached_sentence(text: str, provider, aligner, cache_root: Path) -> tuple[Path, int, list[dict]]:
    spoken, mapped = spoken_sentence(text)
    key = digest_text(canonical_json({"pipeline": PIPELINE_VERSION, "provider": provider.fingerprint,
                                    "spoken": spoken, "textHash": digest_text(text)}).decode())
    path = child_path(cache_root, "sentences", key[:2], key + ".wav")
    record_path = path.with_suffix(".json")
    record, count = {}, 0
    if path.is_file() and record_path.is_file():
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            with wave.open(str(path), "rb") as handle:
                count = handle.getnframes()
                if (handle.getframerate(), handle.getnchannels(), handle.getsampwidth()) != (SAMPLE_RATE, 1, 2):
                    count = 0
            if count <= 0 or record.get("frames") != count or record.get("sha256") != file_digest(path):
                count = 0
        except (OSError, ValueError, EOFError, wave.Error):
            count = 0
    if not count:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".wav", delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            with wave.open(str(temporary_path), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(SAMPLE_RATE)
                blocks = provider.pcm_chunks(spoken) if mapped else [b"\0\0" * (SAMPLE_RATE // 4)]
                for block in blocks:
                    if not isinstance(block, bytes) or len(block) % 2:
                        raise PreparationError("The narration provider returned invalid sentence PCM.")
                    count += len(block) // 2
                    handle.writeframesraw(block)
            if not count:
                raise PreparationError("A sentence produced no audio.")
            temporary_path.replace(path)
            record = {"frames": count, "sha256": file_digest(path)}
            atomic_json(record_path, record)
        finally:
            temporary_path.unlink(missing_ok=True)
    alignment_key = hashlib.sha256(canonical_json({"audioSha256": record["sha256"], "aligner": aligner.fingerprint,
                                                 "mapped": mapped, "spoken": spoken})).hexdigest()
    alignment_path = path.with_name(path.stem + "." + alignment_key + ".alignment.json")
    if alignment_path.is_file():
        try:
            cached = json.loads(alignment_path.read_text(encoding="utf-8"))
            words = cached["words"]
            if cached.get("audioSha256") == record["sha256"] and cached.get("alignmentKey") == alignment_key and cached.get("wordsSha256") == hashlib.sha256(canonical_json(words)).hexdigest() and valid_words(words, mapped, count / SAMPLE_RATE):
                return path, count, words
        except (OSError, ValueError, KeyError, TypeError):
            pass
    words = aligner.align(path, spoken, mapped) if mapped else []
    if not valid_words(words, mapped, count / SAMPLE_RATE):
        raise PreparationError("The acoustic alignment does not cover every exact source word in order. No estimated cues were saved.")
    atomic_json(alignment_path, {"audioSha256": record["sha256"], "alignmentKey": alignment_key,
                                "wordsSha256": hashlib.sha256(canonical_json(words)).hexdigest(), "words": words})
    return path, count, words


def valid_words(words: object, mapped: list[dict], duration: float) -> bool:
    if not isinstance(words, list) or len(words) != len(mapped):
        return False
    previous = 0.0
    for word, source in zip(words, mapped):
        if not isinstance(word, dict) or (word.get("charStart"), word.get("charEnd")) != (source["charStart"], source["charEnd"]):
            return False
        start, end = word.get("startSeconds"), word.get("endSeconds")
        if type(start) not in (int, float) or type(end) not in (int, float) or not math.isfinite(start) or not math.isfinite(end) or not 0 <= previous <= start < end <= duration + 0.000001:
            return False
        previous = end
        confidence = word.get("confidence")
        if type(confidence) not in (int, float) or not math.isfinite(confidence) or not MINIMUM_WORD_CONFIDENCE <= confidence <= 1:
            return False
    if words and sum(word["confidence"] for word in words) / len(words) < MINIMUM_MEAN_CONFIDENCE:
        return False
    return True


def encode_opus(chunks: list[tuple[Path, int, int]], output: Path, ffmpeg: str, ffprobe: str, bitrate: str) -> tuple[int, float]:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".opus", delete=False) as temporary:
        path = Path(temporary.name)
    frames = 0
    try:
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-c:a", "libopus", "-application", "audio", "-b:a", bitrate, "-vbr", "on", "-f", "opus", str(path)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
            assert process.stdin
            try:
                for source, count, gap in chunks:
                    with wave.open(str(source), "rb") as audio:
                        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()) != (1, 2, SAMPLE_RATE, count):
                            raise PreparationError("A cached sentence changed while the chapter was being encoded.")
                        for block in iter(lambda: audio.readframes(32768), b""):
                            process.stdin.write(block)
                    process.stdin.write(b"\0\0" * gap)
                    frames += count + gap
                process.stdin.close()
                code = process.wait()
            except BaseException:
                with contextlib.suppress(OSError):
                    process.stdin.close()
                if process.poll() is None:
                    process.terminate()
                process.wait()
                raise
            if code:
                raise PreparationError("FFmpeg could not encode Opus. Its build must include libopus.")
        duration = probe_duration(path, ffprobe)
        if abs(duration - frames / SAMPLE_RATE) > 0.05:
            raise PreparationError("The Opus container differs from the PCM timeline by more than 50 ms. The chapter was not activated.")
        path.replace(output)
        return frames, duration
    except BrokenPipeError as error:
        raise PreparationError("FFmpeg stopped while encoding. Check libopus and local disk space.") from error
    finally:
        path.unlink(missing_ok=True)


def reusable_chapter(chapter: dict, source: dict, generation_base: Path, chapter_index: int) -> bool:
    try:
        path = generation_base / f"chapter-{chapter_index + 1:04d}.opus"
        if not path.is_file() or chapter.get("audioSha256") != file_digest(path) or chapter.get("byteLength") != path.stat().st_size:
            return False
        if len(chapter["segments"]) != len(source["paragraphs"]):
            return False
        for index, text in enumerate(source["paragraphs"]):
            if chapter["segments"][index]["textHash"] != digest_text(text):
                return False
            words = [word for word in chapter["words"] if word["paragraphIndex"] == index]
            if not valid_words(words, source_words(text), chapter["durationSeconds"]):
                return False
            if any(word.get("cfi") != canonical_cfi(chapter_index, index, word["charStart"]) for word in words):
                return False
        return True
    except (KeyError, TypeError, ValueError, OSError):
        return False


def generate_word_audio(args, rights_record, provider_factory=None, aligner_factory=None) -> Path | None:
    from .core import identifier
    identifier(args.book_id, "bookId")
    if not re.fullmatch(r"[ab][fm]_[a-z0-9_]+", args.voice):
        raise PreparationError("Use an English Kokoro voice such as af_heart or bf_emma.")
    language = args.language or args.voice[0]
    if language != args.voice[0]:
        raise PreparationError("The selected voice and language must agree.")
    narrator_id = identifier(args.narrator_id or f"kokoro-{args.voice}", "narratorId")
    if args.narrator_name is not None and (not args.narrator_name.strip() or len(args.narrator_name) > 120):
        raise PreparationError("The narrator name must contain 1 to 120 characters.")
    if not 80 <= args.max_chars <= 1000 or not 0 <= args.paragraph_gap_ms <= 2000:
        raise PreparationError("Use --max-chars between 80 and 1000 and --paragraph-gap-ms between 0 and 2000.")
    book = text_book(args.input, args.edition_id, args.title) if args.input.suffix.lower() == ".txt" else read_book(args.input)
    if args.input.suffix.lower() != ".txt" and (args.edition_id or args.title):
        raise PreparationError("Structured input already supplies its edition ID and chapter titles.")
    selected = select_chapters(args.chapters, len(book["chapters"]))
    count = sum(len(sentence_chunks(text, args.max_chars)) for index in selected for text in book["chapters"][index]["paragraphs"])
    print(f"Book {args.book_id}; edition {book['editionId']}; {len(selected)}/{len(book['chapters'])} chapters; {count} sentence chunks.", flush=True)
    if args.dry_run:
        print("Dry run complete. No dependencies, network access, writes or narration.")
        return None
    rights = rights_record(args, book)
    for chapter_index in selected:
        for paragraph_index, text in enumerate(book["chapters"][chapter_index]["paragraphs"]):
            for start, end in sentence_chunks(text, args.max_chars):
                try:
                    spoken_sentence(text[start:end])
                except PreparationError as error:
                    raise PreparationError(f"Chapter {chapter_index + 1}, paragraph {paragraph_index + 1}: {error}") from error
    ffmpeg, ffprobe = require_encoder()
    if provider_factory is None:
        from .kokoro_provider import KokoroProvider
        provider_factory = KokoroProvider
    if aligner_factory is None:
        from .word_alignment import Wav2Vec2Aligner
        aligner_factory = Wav2Vec2Aligner
    provider = provider_factory(args.voice, language, args.model_revision, args.allow_download, args.device)
    aligner = aligner_factory(args.allow_download, args.device)
    version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, timeout=15, check=False)
    if version.returncode or not version.stdout:
        raise PreparationError("FFmpeg could not report its version.")
    config = {"pipeline": PIPELINE_VERSION, "provider": provider.fingerprint, "aligner": aligner.fingerprint,
              "maxChars": args.max_chars, "paragraphGapMs": args.paragraph_gap_ms, "bitrate": args.bitrate,
              "sampleRate": SAMPLE_RATE, "format": "opus", "locationScheme": LOCATION_SCHEME,
              "minimumSentenceContext": MINIMUM_SENTENCE_CONTEXT,
              "sentenceBoundaryVersion": SENTENCE_BOUNDARY_VERSION,
              "sourceHash": hashlib.sha256(canonical_json(book)).hexdigest(), "encoderVersion": version.stdout.splitlines()[0], "encoderBitexact": True}
    generation_id = hashlib.sha256(canonical_json(config)).hexdigest()[:24]
    base = child_path(args.output_root, args.book_id, book["editionId"], narrator_id)
    generation_base = child_path(base, generation_id)
    generation_base.mkdir(parents=True, exist_ok=True)
    canonical_hash = write_canonical_epub(book, generation_base / "canonical.epub", args.book_id)
    path = base / "manifest.json"
    chapters = {}
    previous_path = generation_base / "manifest.json"
    if previous_path.is_file():
        try:
            previous = json.loads(previous_path.read_text(encoding="utf-8"))
            if previous.get("generationId") == generation_id:
                chapters = {chapter["chapterIndex"]: chapter for chapter in previous.get("chapters", [])}
        except (OSError, ValueError, KeyError, TypeError):
            chapters = {}
    prefix = "/".join((args.book_id, book["editionId"], narrator_id, generation_id))
    manifest = {"schemaVersion": 2, "bookId": args.book_id, "editionId": book["editionId"], "generationId": generation_id,
                "narrator": {"id": narrator_id, "name": args.narrator_name or args.voice.replace("_", " ").title(), "engine": "kokoro", "voice": args.voice, "language": "en-US" if language == "a" else "en-GB"},
                "alignment": "word", "sampleRate": SAMPLE_RATE, "format": "opus", "locationScheme": LOCATION_SCHEME,
                "canonicalEpub": {"path": prefix + "/canonical.epub", "sha256": canonical_hash},
                "coverage": {"complete": False, "totalChapters": len(book["chapters"]), "chapterIndices": []}, "chapters": []}
    atomic_json(generation_base / "preparation.json", {"bookId": args.book_id, "editionId": book["editionId"], "generationId": generation_id,
                "rights": rights, "configuration": config, "preparedAt": datetime.now(timezone.utc).isoformat()})
    started = time.monotonic()
    for chapter_index in selected:
        source = book["chapters"][chapter_index]
        if chapter_index in chapters and reusable_chapter(chapters[chapter_index], source, generation_base, chapter_index):
            print(f"Chapter {chapter_index + 1}: verified Opus and word cues reused, no narration, alignment or encoding.", flush=True)
        else:
            print(f"Preparing chapter {chapter_index + 1} ({len(source['paragraphs'])} paragraphs).", flush=True)
            chunks, segments, words, sentences, cursor = [], [], [], [], 0
            for paragraph_index, text in enumerate(source["paragraphs"]):
                paragraph_start = cursor
                ranges = sentence_chunks(text, args.max_chars)
                for sentence_index, (start, end) in enumerate(ranges):
                    try:
                        audio_path, frames, aligned = cached_sentence(text[start:end], provider, aligner, args.cache_root)
                    except PreparationError as error:
                        raise PreparationError(f"Chapter {chapter_index + 1}, paragraph {paragraph_index + 1}, sentence chunk {sentence_index + 1}: {error}") from error
                    offset = utf16_offset(text, start)
                    for word in aligned:
                        char_start, char_end = offset + word["charStart"], offset + word["charEnd"]
                        words.append({"paragraphIndex": paragraph_index, "charStart": char_start, "charEnd": char_end,
                                      "startSeconds": cursor / SAMPLE_RATE + word["startSeconds"],
                                      "endSeconds": cursor / SAMPLE_RATE + word["endSeconds"],
                                      "confidence": word["confidence"],
                                      "cfi": canonical_cfi(chapter_index, paragraph_index, char_start)})
                    sentences.append({"paragraphIndex": paragraph_index, "charStart": offset, "charEnd": utf16_offset(text, end),
                                      "startSeconds": cursor / SAMPLE_RATE, "endSeconds": (cursor + frames) / SAMPLE_RATE})
                    gap = round(args.paragraph_gap_ms * SAMPLE_RATE / 1000) if sentence_index == len(ranges) - 1 and paragraph_index < len(source["paragraphs"]) - 1 else 0
                    chunks.append((audio_path, frames, gap))
                    cursor += frames + gap
                segments.append({"paragraphIndex": paragraph_index, "startSeconds": paragraph_start / SAMPLE_RATE,
                                 "endSeconds": cursor / SAMPLE_RATE, "startSample": paragraph_start, "endSample": cursor, "textHash": digest_text(text)})
            name = f"chapter-{chapter_index + 1:04d}.opus"
            audio_file = generation_base / name
            frames, encoded_duration = encode_opus(chunks, audio_file, ffmpeg, ffprobe, args.bitrate)
            chapter = {"chapterIndex": chapter_index, "chapterId": source["id"], "title": source["title"], "audioPath": prefix + "/" + name,
                       "durationSeconds": frames / SAMPLE_RATE, "encodedDurationSeconds": encoded_duration,
                       "audioSha256": file_digest(audio_file), "byteLength": audio_file.stat().st_size,
                       "segments": segments, "words": words, "sentences": sentences}
            if not reusable_chapter(chapter, source, generation_base, chapter_index):
                raise PreparationError("The encoded chapter failed exact source coverage and CFI validation. It was not activated.")
            chapters[chapter_index] = chapter
            print(f"Chapter ready: {frames / SAMPLE_RATE:.2f}s, {audio_file.stat().st_size:,} bytes, {len(words)} forced-aligned words.", flush=True)
        manifest["chapters"] = [chapters[index] for index in sorted(chapters)]
        manifest["coverage"]["chapterIndices"] = sorted(chapters)
        manifest["coverage"]["complete"] = sorted(chapters) == list(range(len(book["chapters"])))
        atomic_json(path, manifest)
        atomic_json(previous_path, manifest)
    print(f"Finished in {time.monotonic() - started:.1f}s. Manifest: {path}", flush=True)
    return path
