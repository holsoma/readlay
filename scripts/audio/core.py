"""Dependency-free text, timing, cache and MP3 preparation functions."""

from __future__ import annotations

import hashlib
import contextlib
import json
import math
import re
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Iterable, Protocol

SAMPLE_RATE = 24_000
PIPELINE_VERSION = "readlay-audio-v1"
IDENTIFIER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$")


class PreparationError(Exception):
    """A preparation failure with a message safe to display in the terminal."""


class NarrationProvider(Protocol):
    fingerprint: dict

    def pcm_chunks(self, text: str) -> Iterable[bytes]:
        """Yield mono, little-endian, signed 16-bit PCM at SAMPLE_RATE."""


def canonical_json(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def file_digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise PreparationError(f"{label} must contain only letters, numbers, hyphens or underscores (up to 96 characters).")
    return value


def child_path(root: Path, *parts: str) -> Path:
    root = root.resolve()
    target = root.joinpath(*parts).resolve()
    if not target.is_relative_to(root):
        raise PreparationError("A file path leaves the selected output folder.")
    return target


def read_book(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PreparationError("The input must be readable UTF-8 structured book JSON.") from error
    if not isinstance(data, dict):
        raise PreparationError("The input must be a structured book object.")
    identifier(data.get("editionId", ""), "editionId")
    chapters = data.get("chapters")
    if not isinstance(chapters, list) or not chapters:
        raise PreparationError("The input has no chapters.")
    seen = set()
    for index, chapter in enumerate(chapters):
        if not isinstance(chapter, dict):
            raise PreparationError(f"Chapter {index} is not an object.")
        chapter_id = identifier(chapter.get("id", ""), "chapter id")
        if chapter_id in seen:
            raise PreparationError("Chapter IDs must be unique.")
        seen.add(chapter_id)
        if not isinstance(chapter.get("title"), str) or not chapter["title"].strip():
            raise PreparationError(f"Chapter {index} has no title.")
        paragraphs = chapter.get("paragraphs")
        if not isinstance(paragraphs, list) or not paragraphs:
            raise PreparationError(f"Chapter {index} is empty. Clean the source book before narration.")
        if any(not isinstance(text, str) or not text.strip() for text in paragraphs):
            raise PreparationError(f"Chapter {index} has an empty paragraph. Clean the source before narration.")
    return data


def text_book(path: Path, edition_id: str | None, title: str | None) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise PreparationError("The text input must be readable UTF-8.") from error
    paragraphs = [part.strip() for part in re.split(r"\r?\n\s*\r?\n", text) if part.strip()]
    if not paragraphs:
        raise PreparationError("The text input is empty.")
    return {
        "editionId": identifier(edition_id or digest_text(text)[:16], "editionId"),
        "chapters": [{"id": "chapter-1", "title": title or path.stem, "paragraphs": paragraphs}],
    }


def split_paragraph(text: str, max_chars: int = 350) -> list[str]:
    """Keep all non-whitespace text, preferring sentence then word boundaries."""
    if not 80 <= max_chars <= 1000:
        raise PreparationError("The chunk limit must be between 80 and 1000 characters.")
    remaining = re.sub(r"\s+", " ", text).strip()
    result = []
    while len(remaining) > max_chars:
        window = remaining[: max_chars + 1]
        sentence_ends = list(re.finditer(r"[.!?;:][\"'”’)]*\s+", window))
        cut = sentence_ends[-1].end() if sentence_ends else window.rfind(" ")
        if cut < max_chars // 3:
            cut = max_chars
        result.append(remaining[:cut].strip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        result.append(remaining)
    return result


def select_chapters(selection: str | None, count: int) -> list[int]:
    """CLI chapter numbers are one based; stored chapter indices are zero based."""
    if not selection:
        return list(range(count))
    result = set()
    try:
        for item in selection.split(","):
            limits = item.strip().split("-")
            if len(limits) > 2:
                raise ValueError
            start = int(limits[0])
            end = int(limits[-1])
            if not 1 <= start <= end <= count:
                raise ValueError
            result.update(range(start - 1, end))
    except ValueError as error:
        raise PreparationError(f"Use chapter numbers from 1 to {count}, such as 1,3-5.") from error
    return sorted(result)


def atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def cache_paragraph(text: str, provider: NarrationProvider, cache_root: Path, max_chars: int) -> tuple[Path, int]:
    key = hashlib.sha256(canonical_json({"pipeline": PIPELINE_VERSION, "provider": provider.fingerprint, "maxChars": max_chars, "textHash": digest_text(text)})).hexdigest()
    path = child_path(cache_root, key[:2], key + ".wav")
    metadata_path = path.with_suffix(".json")
    if path.is_file() and metadata_path.is_file():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            with wave.open(str(path), "rb") as audio:
                count = audio.getnframes()
                valid = (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, SAMPLE_RATE)
            if valid and count > 0 and metadata.get("frames") == count and metadata.get("sha256") == file_digest(path):
                return path, count
        except (OSError, EOFError, wave.Error, json.JSONDecodeError):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".wav", delete=False) as temporary:
        temp_path = Path(temporary.name)
    count = 0
    try:
        with wave.open(str(temp_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            if not any(character.isalnum() for character in text):
                block = b"\0\0" * (SAMPLE_RATE // 4)
                output.writeframesraw(block)
                count = len(block) // 2
            else:
                for chunk in split_paragraph(text, max_chars):
                    chunk_frames = 0
                    for block in provider.pcm_chunks(chunk):
                        if not isinstance(block, bytes) or len(block) % 2:
                            raise PreparationError("The narration provider returned invalid PCM audio.")
                        output.writeframesraw(block)
                        chunk_frames += len(block) // 2
                    if chunk_frames == 0:
                        raise PreparationError("A text chunk produced no audio. Check the text and voice before continuing.")
                    count += chunk_frames
        temp_path.replace(path)
        atomic_json(metadata_path, {"frames": count, "sha256": file_digest(path)})
    finally:
        temp_path.unlink(missing_ok=True)
    return path, count


def require_encoder(ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe") -> tuple[str, str]:
    encoder, probe = shutil.which(ffmpeg), shutil.which(ffprobe)
    if not encoder or not probe:
        raise PreparationError("Install ffmpeg and ffprobe, and add both commands to PATH before generating audio.")
    return encoder, probe


def probe_duration(path: Path, ffprobe: str) -> float:
    result = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], capture_output=True, text=True, check=False)
    try:
        duration = float(result.stdout.strip())
    except ValueError as error:
        raise PreparationError("ffprobe could not read the encoded chapter duration.") from error
    if result.returncode or not math.isfinite(duration) or duration <= 0:
        raise PreparationError("ffprobe could not validate the encoded chapter.")
    return duration


def encode_chapter(paragraphs: list[tuple[Path, int]], output_path: Path, gap_samples: int, ffmpeg: str, ffprobe: str, bitrate: str = "64k") -> tuple[list[tuple[int, int]], int, float]:
    """Stream cached PCM into one encoder. No chapter-sized array is allocated."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output_path.parent, suffix=".mp3", delete=False) as handle:
        temp_path = Path(handle.name)
    intervals = []
    cursor = 0
    try:
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0", "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", bitrate, "-write_xing", "1", "-id3v2_version", "3", str(temp_path)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
            assert process.stdin is not None
            try:
                for index, (path, frames) in enumerate(paragraphs):
                    start = cursor
                    with wave.open(str(path), "rb") as audio:
                        for block in iter(lambda: audio.readframes(32_768), b""):
                            process.stdin.write(block)
                    cursor += frames
                    if index < len(paragraphs) - 1:
                        process.stdin.write(b"\0\0" * gap_samples)
                        cursor += gap_samples
                    intervals.append((start, cursor))
                process.stdin.close()
                return_code = process.wait()
            except BaseException:
                with contextlib.suppress(OSError):
                    process.stdin.close()
                if process.poll() is None:
                    process.terminate()
                process.wait()
                raise
            if return_code:
                raise PreparationError("ffmpeg failed to encode a chapter. Check that its build includes libmp3lame.")
        encoded_duration = probe_duration(temp_path, ffprobe)
        if abs(encoded_duration - cursor / SAMPLE_RATE) > 0.20:
            raise PreparationError("The MP3 duration differs from the PCM timeline by more than 0.20 seconds. The chapter was not published.")
        temp_path.replace(output_path)
        return intervals, cursor, encoded_duration
    except BrokenPipeError as error:
        raise PreparationError("ffmpeg stopped before the chapter was encoded. Check available disk space and its libmp3lame encoder.") from error
    finally:
        temp_path.unlink(missing_ok=True)
