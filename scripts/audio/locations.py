"""Exact source ranges and a real cleaned EPUB for Readlay's CFI scheme."""

from __future__ import annotations

import re
import tempfile
import zipfile
from html import escape
from pathlib import Path

from .core import PreparationError, file_digest

LOCATION_SCHEME = "readlay-canonical-epub-v1"
WORD_PATTERN = re.compile(r"\d+(?:[,.]\d+)+|[^\W_]+(?:['’\-‐‑][^\W_]+)*", re.UNICODE)


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
