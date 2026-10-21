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
from .locations import LOCATION_SCHEME, SOURCE_MAPPING_VERSION, canonical_cfi, corrected_source, load_reader_corrections, sentence_corrections, source_words, utf16_offset, write_canonical_epub
from .word_alignment import AcousticAlignmentError, MINIMUM_MEAN_CONFIDENCE, MINIMUM_WORD_CONFIDENCE, spoken_sentence

PIPELINE_VERSION = "readlay-word-audio-v2.5"
MINIMUM_SENTENCE_CONTEXT = 40
SENTENCE_BOUNDARY_VERSION = 2
CONTEXT_FALLBACK_VERSION = "measured-source-context-v1"
CONTEXT_SOURCE_CHARS = 120


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


def spoken_source_sentence(text: str, corrections: list[dict] | None = None) -> tuple[str, list[dict]]:
    """Align reviewed speech to original words, including one-to-many repairs.

    The acoustic aligner sees the same corrected transcript as Kokoro. Each
    canonical source token owns every spoken label in its replacement, so a
    joined source token receives one measured cue spanning its full expansion.
    """
    if not corrections:
        return spoken_sentence(text)
    display, canonical = corrected_source(text, corrections)
    spoken, visible = spoken_sentence(display)
    mapped, position = [], 0
    for source in canonical:
        owned = []
        while position < len(visible) and visible[position]["start"] < source["displayEnd"]:
            word = visible[position]
            if word["start"] < source["displayStart"] or word["end"] > source["displayEnd"]:
                raise PreparationError("A reviewed replacement cannot be mapped to one original source token.")
            owned.append(word)
            position += 1
        if not owned:
            raise PreparationError("A reviewed source token has no spoken alignment words.")
        mapped.append({key: source[key] for key in ("text", "start", "end", "charStart", "charEnd")} |
                      {"spokenStart": owned[0]["spokenStart"], "spokenEnd": owned[-1]["spokenEnd"]})
    if position != len(visible):
        raise PreparationError("The corrected transcript contains words outside the canonical source mapping.")
    return spoken, mapped


def cached_sentence(text: str, provider, aligner, cache_root: Path, corrections: list[dict] | None = None) -> tuple[Path, int, list[dict]]:
    spoken, mapped = spoken_source_sentence(text, corrections)
    cache_config = {"pipeline": PIPELINE_VERSION, "provider": provider.fingerprint,
                    "spoken": spoken, "textHash": digest_text(text)}
    if corrections:
        cache_config["sourceMapping"] = {"version": SOURCE_MAPPING_VERSION,
                                         "sha256": hashlib.sha256(canonical_json(corrections)).hexdigest()}
    key = digest_text(canonical_json(cache_config).decode())
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
        raise AcousticAlignmentError("The acoustic alignment does not cover every exact source word in order. No estimated cues were saved.")
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


def source_context(chapter: dict, chapter_index: int, paragraph_index: int, start: int, end: int, corrections: dict, context_chars: int = CONTEXT_SOURCE_CHARS) -> tuple[str, list[dict], int, int]:
    """Bounded whole source words around a candidate, with exact local repairs."""
    paragraphs = chapter["paragraphs"]

    def edge(index: int, lo: int, hi: int, budget: int, before: bool):
        text = paragraphs[index]
        words = [word for word in source_words(text) if lo <= word["start"] and word["end"] <= hi]
        if before:
            words = [word for word in words if word["start"] >= hi - budget]
            if not words:
                return None
            lo = words[0]["start"]
        else:
            words = [word for word in words if word["end"] <= lo + budget]
            if not words:
                return None
            bound, hi = min(hi, lo + budget), words[-1]["end"]
            while hi < bound and text[hi] in ".,!?;:'\"”’)] ":
                hi += 1
            stops = [match.end() for match in re.finditer(r"[.!?][\"'”’)]*(?:\s+|$)", text[lo:hi]) if match.end() >= 30]
            if stops:
                hi = lo + stops[-1]
        return index, lo, hi

    before, after = [], []
    remaining = context_chars
    for index in range(paragraph_index, max(-1, paragraph_index - 4), -1):
        hi = start if index == paragraph_index else len(paragraphs[index])
        piece = edge(index, 0, hi, remaining, True)
        if piece:
            before.insert(0, piece)
            remaining -= piece[2] - piece[1] + 1
            if piece[1] > 0:
                break
        elif source_words(paragraphs[index][:hi]):
            break
        if remaining <= 0:
            break
    remaining = context_chars
    for index in range(paragraph_index, min(len(paragraphs), paragraph_index + 4)):
        lo = end if index == paragraph_index else 0
        piece = edge(index, lo, len(paragraphs[index]), remaining, False)
        if piece:
            after.append(piece)
            remaining -= piece[2] - piece[1] + 1
            if piece[2] < len(paragraphs[index]):
                break
        elif source_words(paragraphs[index][lo:]):
            break
        if remaining <= 0:
            break
    if not before and not after:
        raise AcousticAlignmentError("No bounded neighbouring source words are available for measured context recovery.")
    parts, changes, cursor = [], [], 0
    candidate_start = candidate_end = 0
    pieces = before + [(paragraph_index, start, end)] + after
    for piece_index, (index, lo, hi) in enumerate(pieces):
        if parts:
            parts.append(" ")
            cursor += 1
        if piece_index == len(before):
            candidate_start = cursor
        source = paragraphs[index]
        for change in sentence_corrections(source, lo, hi, corrections.get((chapter_index, index), [])):
            offset = utf16_offset("".join(parts), cursor)
            changes.append({**change, "charStart": change["charStart"] + offset, "charEnd": change["charEnd"] + offset})
        part = source[lo:hi]
        parts.append(part)
        cursor += len(part)
        if piece_index == len(before):
            candidate_end = cursor
    return "".join(parts), changes, candidate_start, candidate_end


def cached_context_sentence(text: str, context: str, changes: list[dict], start: int, end: int, provider, aligner, cache_root: Path) -> tuple[Path, int, list[dict]]:
    """Keep target speech between measured context-word boundaries only."""
    if context[start:end] != text:
        raise PreparationError("The context recipe differs from its exact target source.")
    full_path, full_frames, aligned = cached_sentence(context, provider, aligner, cache_root, changes)
    offset, limit = utf16_offset(context, start), utf16_offset(context, end)
    selected = [word for word in aligned if offset <= word["charStart"] and word["charEnd"] <= limit]
    expected = source_words(text)
    if not selected or [(word["charStart"] - offset, word["charEnd"] - offset) for word in selected] != [(word["charStart"], word["charEnd"]) for word in expected]:
        raise AcousticAlignmentError("The context recording does not contain every exact candidate source word.")
    preceding = [word for word in aligned if word["charEnd"] <= offset]
    following = [word for word in aligned if word["charStart"] >= limit]
    first_frame = math.floor(preceding[-1]["endSeconds"] * SAMPLE_RATE) if preceding else 0
    last_frame = math.ceil(following[0]["startSeconds"] * SAMPLE_RATE) if following else full_frames
    frames = last_frame - first_frame
    if not 0 <= first_frame < last_frame <= full_frames:
        raise AcousticAlignmentError("The measured context boundaries do not form a valid candidate clip.")
    words = [{**word, "charStart": word["charStart"] - offset, "charEnd": word["charEnd"] - offset,
              "startSeconds": word["startSeconds"] - first_frame / SAMPLE_RATE,
              "endSeconds": word["endSeconds"] - first_frame / SAMPLE_RATE} for word in selected]
    if not valid_words(words, expected, frames / SAMPLE_RATE):
        raise AcousticAlignmentError("The measured context clip failed unchanged confidence, order or exact source coverage checks.")
    recipe = {"algorithm": CONTEXT_FALLBACK_VERSION, "contextSourceHash": digest_text(context), "targetSourceHash": digest_text(text),
              "contextAudioSha256": file_digest(full_path), "contextWordsSha256": hashlib.sha256(canonical_json(aligned)).hexdigest(),
              "targetPythonStart": start, "targetPythonEnd": end, "firstFrame": first_frame, "lastFrame": last_frame,
              "sourceMappingSha256": hashlib.sha256(canonical_json(changes)).hexdigest(), "aligner": aligner.fingerprint}
    key = hashlib.sha256(canonical_json(recipe)).hexdigest()
    path = child_path(cache_root, "contextual", key[:2], key + ".wav")
    record_path = path.with_suffix(".json")
    if path.is_file() and record_path.is_file():
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            with wave.open(str(path), "rb") as handle:
                valid_audio = (handle.getframerate(), handle.getnchannels(), handle.getsampwidth(), handle.getnframes()) == (SAMPLE_RATE, 1, 2, frames)
            if valid_audio and record.get("recipe") == recipe and record.get("sha256") == file_digest(path) and record.get("words") == words:
                return path, frames, words
        except (OSError, ValueError, EOFError, wave.Error):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".wav", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with wave.open(str(full_path), "rb") as original, wave.open(str(temporary_path), "wb") as clipped:
            clipped.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            original.setpos(first_frame)
            remaining = frames
            while remaining:
                count = min(32768, remaining)
                block = original.readframes(count)
                if len(block) != count * 2:
                    raise PreparationError("The verified context recording changed while clipping.")
                clipped.writeframesraw(block)
                remaining -= count
        temporary_path.replace(path)
        atomic_json(record_path, {"recipe": recipe, "frames": frames, "sha256": file_digest(path), "words": words})
    finally:
        temporary_path.unlink(missing_ok=True)
    return path, frames, words


def recover_sentence(chapter: dict, chapter_index: int, paragraph_index: int, start: int, end: int, corrections: dict, provider, aligner, cache_root: Path):
    """Try normal cached narration first; only acoustic failures need context."""
    text = chapter["paragraphs"][paragraph_index]
    changes = sentence_corrections(text, start, end, corrections.get((chapter_index, paragraph_index), []))
    try:
        return cached_sentence(text[start:end], provider, aligner, cache_root, changes)
    except AcousticAlignmentError:
        print(f"Retrying chapter {chapter_index + 1}, paragraph {paragraph_index + 1} with bounded source context and measured audio boundaries.", flush=True)
        last_error = None
        for context_chars in (CONTEXT_SOURCE_CHARS, 80, 40):
            try:
                context, context_changes, target_start, target_end = source_context(chapter, chapter_index, paragraph_index, start, end, corrections, context_chars)
                return cached_context_sentence(text[start:end], context, context_changes, target_start, target_end, provider, aligner, cache_root)
            except AcousticAlignmentError as error:
                last_error = error
        assert last_error
        raise last_error


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
    presentation = getattr(args, "reader_presentation", None)
    if presentation is None and args.input.suffix.lower() == ".json" and args.input.parent.name == "books":
        sibling = args.input.parent.parent / "reader" / f"{args.book_id}.json"
        presentation = sibling if sibling.exists() else None
    corrections = load_reader_corrections(book, args.book_id, presentation)
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
                    spoken_source_sentence(text[start:end], sentence_corrections(text, start, end, corrections.get((chapter_index, paragraph_index), [])))
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
              "contextFallback": CONTEXT_FALLBACK_VERSION, "contextSourceChars": CONTEXT_SOURCE_CHARS,
              "sentenceBoundaryVersion": SENTENCE_BOUNDARY_VERSION,
              "sourceHash": hashlib.sha256(canonical_json(book)).hexdigest(), "encoderVersion": version.stdout.splitlines()[0], "encoderBitexact": True}
    if corrections:
        mapping = [{"chapterIndex": chapter, "paragraphIndex": paragraph, **change}
                   for (chapter, paragraph), changes in sorted(corrections.items()) for change in changes]
        config["sourceMapping"] = {"version": SOURCE_MAPPING_VERSION,
                                   "sha256": hashlib.sha256(canonical_json(mapping)).hexdigest(),
                                   "correctionCount": len(mapping)}
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
                "narrator": {"id": narrator_id, "name": args.narrator_name or args.voice.replace("_", " ").title(), "engine": "kokoro", "voice": args.voice, "language": "en-US" if language == "a" else "en-GB", "gender": "female" if args.voice[1] == "f" else "male"},
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
                        audio_path, frames, aligned = recover_sentence(source, chapter_index, paragraph_index, start, end, corrections, provider, aligner, args.cache_root)
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
