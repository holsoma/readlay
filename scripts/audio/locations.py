"""Exact source ranges and a real cleaned EPUB for Readlay's CFI scheme."""

from __future__ import annotations

import json
import re
import tempfile
import zipfile
from html import escape
from pathlib import Path

from .core import PreparationError, file_digest

LOCATION_SCHEME = "readlay-canonical-epub-v1"
WORD_PATTERN = re.compile(r"\d+(?:[,.]\d+)+|[^\W_]+(?:['’\-‐‑][^\W_]+)*", re.UNICODE)
SOURCE_MAPPING_VERSION = "readlay-reviewed-source-map-v1"


def xml_text(text: str) -> str:
    if any(not (ord(character) in (9, 10, 13) or 0x20 <= ord(character) <= 0xD7FF or 0xE000 <= ord(character) <= 0xFFFD or 0x10000 <= ord(character) <= 0x10FFFF) for character in text):
        raise PreparationError("The source contains a character that XML cannot preserve. Correct the source before creating canonical EPUB locations.")
    # XML normalises literal CR to LF. A character reference preserves the
    # original source code point and therefore every following UTF-16 offset.
    return escape(text).replace("\r", "&#13;")


def utf16_offset(text: str, offset: int) -> int:
    return len(text[:offset].encode("utf-16-le")) // 2


def source_words(text: str) -> list[dict]:
    return [{"text": match.group(), "start": match.start(), "end": match.end(),
             "charStart": utf16_offset(text, match.start()), "charEnd": utf16_offset(text, match.end())}
            for match in WORD_PATTERN.finditer(text)]


def reviewed_corrections(text: str, values: object) -> list[dict]:
    """Accept only whole original tokens with the reader's exact UTF-16 ranges.

    Audio preparation fails on stale or malformed corrections instead of
    quietly narrating text that differs from the prepared reading interface.
    """
    if not isinstance(values, list) or len(values) > 1000:
        raise PreparationError("Reader corrections must be a list of at most 1,000 reviewed token changes.")
    words = {(word["charStart"], word["charEnd"]): word for word in source_words(text)}
    result, seen = [], set()
    for value in values:
        if not isinstance(value, dict):
            raise PreparationError("A reviewed reader correction is not an object.")
        start, end = value.get("charStart"), value.get("charEnd")
        if type(start) is not int or type(end) is not int or (start, end) not in words or start in seen:
            raise PreparationError("A reviewed correction does not cover one complete original source word.")
        original, replacement = value.get("sourceText"), value.get("replacementText")
        try:
            valid_text = all(isinstance(item, str) and len(item.encode("utf-16-le")) // 2 <= 200 and
                             not re.search(r"[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", item) for item in (original, replacement))
        except UnicodeError:
            valid_text = False
        if not valid_text:
            raise PreparationError("A reviewed correction contains invalid source or replacement text.")
        if original != words[start, end]["text"] or not replacement.strip() or not 1 <= len(source_words(replacement)) <= 6:
            raise PreparationError("A reviewed correction differs from its original source token or has no supported replacement words.")
        seen.add(start)
        result.append({"charStart": start, "charEnd": end, "sourceText": original, "replacementText": replacement})
    return sorted(result, key=lambda item: item["charStart"])


def load_reader_corrections(book: dict, book_id: str, path: Path | None) -> dict[tuple[int, int], list[dict]]:
    """Read speech changes only; images, headings and paths are not audio inputs."""
    if path is None:
        return {}
    try:
        if path.stat().st_size > 8 * 1024 * 1024:
            raise PreparationError("The reader presentation manifest exceeds the preparation limit.")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise PreparationError("The reader presentation manifest must be readable UTF-8 JSON.") from error
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1 or data.get("bookId") != book_id or data.get("editionId") != book["editionId"] or not isinstance(data.get("chapters"), list) or len(data["chapters"]) != len(book["chapters"]):
        raise PreparationError("The reader presentation manifest does not match the canonical book and edition.")
    result = {}
    for chapter_index, chapter in enumerate(data["chapters"]):
        if not isinstance(chapter, dict) or not isinstance(chapter.get("paragraphs"), dict):
            raise PreparationError("The reader presentation has invalid chapter metadata.")
        paragraphs = book["chapters"][chapter_index]["paragraphs"]
        for key, settings in chapter["paragraphs"].items():
            if not isinstance(settings, dict):
                raise PreparationError("The reader presentation has invalid paragraph metadata.")
            if "corrections" not in settings:
                continue
            if not isinstance(key, str) or not re.fullmatch(r"0|[1-9]\d*", key) or int(key) >= len(paragraphs):
                raise PreparationError("A reviewed correction references a missing source paragraph.")
            paragraph_index = int(key)
            changes = reviewed_corrections(paragraphs[paragraph_index], settings["corrections"])
            if changes:
                result[chapter_index, paragraph_index] = changes
    return result


def corrected_source(text: str, corrections: list[dict]) -> tuple[str, list[dict]]:
    """Return visible text and each untouched canonical token's display span."""
    changes = {item["charStart"]: item for item in reviewed_corrections(text, corrections)}
    parts, mapped, cursor, display_cursor = [], [], 0, 0
    for word in source_words(text):
        separator = text[cursor:word["start"]]
        parts.append(separator)
        display_cursor += len(separator)
        shown = changes.get(word["charStart"], {}).get("replacementText", word["text"])
        mapped.append({**word, "displayStart": display_cursor, "displayEnd": display_cursor + len(shown)})
        parts.append(shown)
        display_cursor += len(shown)
        cursor = word["end"]
    parts.append(text[cursor:])
    return "".join(parts), mapped


def sentence_corrections(text: str, start: int, end: int, corrections: list[dict]) -> list[dict]:
    """Move paragraph ranges into a source sentence without truncating a token."""
    offset, limit = utf16_offset(text, start), utf16_offset(text, end)
    result = []
    for change in corrections:
        if change["charEnd"] <= offset or change["charStart"] >= limit:
            continue
        if change["charStart"] < offset or change["charEnd"] > limit:
            raise PreparationError("A sentence boundary truncates a reviewed source correction.")
        result.append({**change, "charStart": change["charStart"] - offset, "charEnd": change["charEnd"] - offset})
    return result


def canonical_cfi(chapter_index: int, paragraph_index: int, char_offset: int) -> str:
    if any(type(value) is not int or value < 0 for value in (chapter_index, paragraph_index, char_offset)):
        raise PreparationError("CFI indices and offsets must be non-negative integers.")
    return f"epubcfi(/6/{2 * (chapter_index + 1)}[chapter-{chapter_index + 1}]!/4/{2 * (paragraph_index + 1)}/1:{char_offset})"


def write_canonical_epub(book: dict, path: Path, book_id: str) -> str:
    """The CFI maps this derivative EPUB, never an invented original-file offset."""
    path.parent.mkdir(parents=True, exist_ok=True)
    files = {
        "META-INF/container.xml": '<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    }
    manifest, spine, nav = [], [], []
    for index, chapter in enumerate(book["chapters"]):
        name = f"chapter-{index + 1}.xhtml"
        chapter_id = f"chapter-{index + 1}"
        paragraphs = "".join(f"<p>{xml_text(text)}</p>" for text in chapter["paragraphs"])
        # No whitespace text nodes or wrappers inside body or p. Each p has one
        # source text node, so the /4/{2*(paragraph+1)}/1 CFI stays literal.
        files["EPUB/" + name] = f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>{escape(chapter["title"])}</title></head><body>{paragraphs}</body></html>'
        content_id = f"content-{index + 1}"
        manifest.append(f'<item id="{content_id}" href="{name}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref id="{chapter_id}" idref="{content_id}"/>')
        nav.append(f'<li><a href="{name}">{escape(chapter["title"])}</a></li>')
    files["EPUB/nav.xhtml"] = '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>' + "".join(nav) + '</ol></nav></body></html>'
    files["EPUB/package.opf"] = '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="book-id"><metadata><dc:identifier id="book-id">urn:readlay:' + escape(book_id) + ':' + escape(book["editionId"]) + '</dc:identifier><dc:title>' + escape(book.get("title") or book_id) + '</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata><manifest>' + "".join(manifest) + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>' + "".join(spine) + '</spine></package>'
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".epub", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name, content in [("mimetype", "application/epub+zip"), *files.items()]:
                info = zipfile.ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED
                archive.writestr(info, content.encode("utf-8"))
        digest = file_digest(temporary)
        if path.exists() and file_digest(path) != digest:
            raise PreparationError("The canonical EPUB at this immutable generation path differs. Use a new generation.")
        if not path.exists():
            temporary.replace(path)
        return digest
    finally:
        temporary.unlink(missing_ok=True)
