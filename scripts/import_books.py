"""Import the supplied EPUB editions into Readlay's private local store.

Run with Python 3.10 or later:
    python scripts/import_books.py --source-dir PATH_TO_EPUB_DIRECTORY

Book text stays in .local/books. The source-controlled statistics contain no
passages, source filenames, user paths or publisher assets. No EPUB HTML, CSS,
JavaScript or external resources are served to the browser.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
import hashlib
from html.entities import name2codepoint
import json
import math
from pathlib import Path
import posixpath
import re
import statistics
import unicodedata
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_RESOURCE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_ZIP_ENTRIES = 5000
MAX_XML_NODES = 200_000
MAX_XML_DEPTH = 128
MAX_PARAGRAPH_CHARS = 100_000
MAX_PARAGRAPHS = 100_000
PARSER_VERSION = "readlay-text-v4"

BOOKS = {
    "atomic-habits": (
        "Atomic Habits",
        "Atomic Habits (James Clear) (z-library.sk, 1lib.sk, z-lib.sk).epub",
    ),
    "seven-habits": (
        "The 7 Habits of Highly Effective People",
        "The seven habits of highly effective people restoring the character ethic (Stephen R Covey) (z-library.sk, 1lib.sk, z-lib.sk).epub",
    ),
    "win-friends": (
        "How to Win Friends and Influence People",
        "How To Win Friends and Influence People (Dale Carnegie) (z-library.sk, 1lib.sk, z-lib.sk).epub",
    ),
    "laws-of-power": (
        "The 48 Laws of Power",
        "The 48 Laws of Power (Robert Greene) (z-library.sk, 1lib.sk, z-lib.sk).epub",
    ),
    "subconscious-mind": (
        "The Power of Your Subconscious Mind",
        "The Power Of The Subconscious - Joseph Murphy.epub",
    ),
    "rich-dad-poor-dad": (
        "Rich Dad Poor Dad",
        "Rich Dad Poor Dad - Robert Kiyosaki and Sharon Lechter.epub",
    ),
    "five-am-club": (
        "The 5 AM Club",
        "The 5 AM Club - Robin Sharma.epub",
    ),
    "power-of-now": (
        "The Power of Now",
        "The Power of Now - Eckhart Tolle..epub",
    ),
}

TITLE_MATCHES = {
    "atomic-habits": ("atomic habits",),
    "seven-habits": ("seven habits of highly effective", "7 habits of highly effective"),
    "win-friends": ("how to win friends and influence people",),
    "laws-of-power": ("48 laws of power",),
    "subconscious-mind": ("power of the subconscious", "power of your subconscious mind"),
    "rich-dad-poor-dad": ("rich dad poor dad",),
    "five-am-club": ("5 am club",),
    "power-of-now": ("power of now",),
}

SKIP_TAGS = {"script", "style", "nav", "noscript", "iframe", "object", "template"}
BLOCK_TAGS = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd",
    "blockquote", "pre", "tr", "figcaption", "div", "section", "article",
    "header", "footer", "aside", "figure", "ul", "ol", "dl", "table",
}
WORD_RE = re.compile(r"\b\w+(?:['’\-]\w+)*\b", re.UNICODE)


class ImportFailure(ValueError):
    """A malformed, encrypted or unsafe EPUB cannot be imported."""


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def normalise_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def resource_path(base: str, href: str) -> tuple[str, str]:
    """Resolve EPUB resource references without allowing external or unsafe paths."""
    url = urlsplit(href)
    if url.scheme or url.netloc or url.query:
        raise ImportFailure("External resource or query in EPUB reference")
    relative = unquote(url.path)
    if "\\" in relative or "\x00" in relative or relative.startswith("/"):
        raise ImportFailure("Unsafe EPUB resource path")
    path = posixpath.normpath(posixpath.join(posixpath.dirname(base), relative))
    if not relative:
        path = base
    if path in {"", ".", ".."} or path.startswith("../") or ":" in path:
        raise ImportFailure("EPUB resource leaves the archive root")
    return path, unquote(url.fragment)


def parse_xml(data: bytes) -> ET.Element:
    if re.search(br"<!ENTITY\s", data, re.I):
        raise ImportFailure("XML entity declarations are not supported")
    # XHTML EPUB 2 documents may reference HTML entities from an external DTD.
    # Replace the known names with numeric entities without fetching that DTD.
    def replace_entity(match: re.Match[bytes]) -> bytes:
        name = match.group(1).decode("ascii")
        codepoint = name2codepoint.get(name)
        return f"&#{codepoint};".encode() if codepoint is not None else match.group(0)

    data = re.sub(br"&([A-Za-z][A-Za-z0-9]+);", replace_entity, data)
    try:
        root = ET.fromstring(data)
    except (ET.ParseError, ValueError) as error:
        raise ImportFailure("Malformed EPUB XML") from error
    count = 0
    stack = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > MAX_XML_NODES or depth > MAX_XML_DEPTH:
            raise ImportFailure("EPUB XML exceeds node or nesting limits")
        stack.extend((child, depth + 1) for child in node)
    return root


class SafeArchive:
    def __init__(self, source: Path):
        if source.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ImportFailure("EPUB exceeds the archive size limit")
        self.archive = zipfile.ZipFile(source)
        entries = self.archive.infolist()
        if len(entries) > MAX_ZIP_ENTRIES:
            raise ImportFailure("EPUB contains too many resources")
        self.entries = {}
        total = 0
        for entry in entries:
            name = entry.filename
            if (
                name.startswith(("/", "\\"))
                or "\\" in name
                or "\x00" in name
                or ":" in name
                or any(part == ".." for part in name.split("/"))
                or name in self.entries
                or entry.flag_bits & 1
            ):
                raise ImportFailure("Unsafe, duplicate or encrypted ZIP entry")
            total += entry.file_size
            if entry.file_size > MAX_RESOURCE_BYTES or total > MAX_TOTAL_BYTES:
                raise ImportFailure("EPUB exceeds expanded resource size limits")
            if entry.file_size > 1024 * 1024 and entry.file_size > max(entry.compress_size, 1) * 1000:
                raise ImportFailure("EPUB has an excessive compression ratio")
            self.entries[name] = entry
        if self.read("mimetype").strip() != b"application/epub+zip":
            raise ImportFailure("File does not declare the EPUB media type")
        if any(name.lower() in {"meta-inf/encryption.xml", "meta-inf/rights.xml", "meta-inf/license.lcpl"} for name in self.entries):
            raise ImportFailure("Encrypted or rights-managed EPUBs are not supported")

    def read(self, name: str) -> bytes:
        if name not in self.entries:
            raise ImportFailure("EPUB references a missing resource")
        return self.archive.read(self.entries[name])

    def close(self) -> None:
        self.archive.close()


@dataclass
class TocEntry:
    path: str
    anchor: str
    title: str
    depth: int


def read_toc(archive: SafeArchive, path: str) -> list[TocEntry]:
    root = parse_xml(archive.read(path))
    result = []

    def walk(node: ET.Element, depth: int) -> None:
        if local_name(node.tag) == "navpoint":
            label = next((c for c in node if local_name(c.tag) == "navlabel"), None)
            content = next((c for c in node if local_name(c.tag) == "content"), None)
            title = normalise_text("".join(label.itertext())) if label is not None else ""
            if content is not None and content.get("src") and title:
                target, anchor = resource_path(path, content.get("src", ""))
                result.append(TocEntry(target, anchor, title[:250], depth))
            depth += 1
        for child in node:
            walk(child, depth)

    walk(root, 0)
    return result


def large_type_classes(css: str) -> set[str]:
    """Some older EPUBs use styled paragraphs instead of semantic headings."""
    classes = set()
    for selector, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        size = re.search(r"font-size\s*:\s*([0-9.]+)\s*(em|rem|px|pt|%)", declarations, re.I)
        if not size:
            continue
        value = float(size.group(1))
        minimum = {"em": 1.3, "rem": 1.3, "px": 21, "pt": 16, "%": 130}[size.group(2).lower()]
        if value >= minimum:
            classes.update(re.findall(r"\.([\w-]+)", selector))
    return classes


def join_wrapped_lines(root: ET.Element, css: str, large_classes: set[str]) -> None:
    """Repair this older Carnegie edition's one-paragraph-per-printed-line layout.

    Indented starts, blank lines, headings, other block types and short completed
    lines retain their boundaries. Text and inline elements remain in order.
    """
    paragraphs = [node for node in root.iter() if local_name(node.tag) == "p"]
    if len(paragraphs) < 1000:
        return
    counts = Counter(node.get("class", "") for node in paragraphs)
    ordinary_class, count = counts.most_common(1)[0]
    if count < len(paragraphs) * 0.7:
        return
    lengths = [len(normalise_text("".join(node.itertext()))) for node in paragraphs if node.get("class", "") == ordinary_class and normalise_text("".join(node.itertext()))]
    line_width = statistics.median(lengths)
    if not 35 <= line_width <= 90:
        return
    indented_classes = set()
    for selector, declarations in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        indent = re.search(r"text-indent\s*:\s*([0-9.]+)", declarations, re.I)
        if indent and float(indent.group(1)) > 0:
            indented_classes.update(re.findall(r"\.([\w-]+)", selector))
    allowed_previous = indented_classes | {ordinary_class}
    sentence_end = re.compile(r"[.!?:][\"'”’)]?$")
    for parent in root.iter():
        previous = None
        previous_line = ""
        for node in list(parent):
            if local_name(node.tag) != "p":
                previous = None
                continue
            text = normalise_text("".join(node.itertext()))
            classes = node.get("class", "").split()
            heading = any(large_classes.intersection(child.get("class", "").split()) for child in node.iter())
            can_join = (
                previous is not None
                and text
                and not heading
                and node.get("class", "") == ordinary_class
                and previous.get("class", "") in allowed_previous
                and len(previous_line) >= max(30, line_width * 0.75)
                and not (sentence_end.search(previous_line) and len(previous_line) < line_width * 0.9)
            )
            if can_join:
                if node.get("id"):
                    marker = ET.Element("span", {"id": node.get("id", "")})
                    previous.append(marker)
                prefix = " " + (node.text or "")
                if len(previous):
                    previous[-1].tail = (previous[-1].tail or "") + prefix
                else:
                    previous.text = (previous.text or "") + prefix
                for child in list(node):
                    previous.append(child)
                previous.tail = node.tail
                parent.remove(node)
            else:
                previous = node if text and not heading and node.get("class", "") in allowed_previous else None
            previous_line = text


@dataclass
class ExtractedText:
    paragraphs: list[str]
    anchors: dict[str, int]
    headings: dict[int, str]
    inferred_headings: dict[int, str]
    omitted_images: int
    paragraph_attributes: dict[int, dict]


def extract_text(root: ET.Element, large_classes: set[str]) -> ExtractedText:
    body = next((node for node in root.iter() if local_name(node.tag) == "body"), None)
    if body is None:
        raise ImportFailure("EPUB text resource has no body")
    paragraphs: list[str] = []
    anchors: dict[str, int] = {}
    headings: dict[int, str] = {}
    inferred: dict[int, str] = {}
    attributes: dict[int, dict] = {}
    buffer: list[str] = []
    omitted_images = 0

    def flush() -> None:
        value = normalise_text("".join(buffer))
        buffer.clear()
        if not value:
            return
        if len(value) > MAX_PARAGRAPH_CHARS or len(paragraphs) >= MAX_PARAGRAPHS:
            raise ImportFailure("EPUB text exceeds paragraph limits")
        paragraphs.append(value)

    def walk(node: ET.Element) -> None:
        nonlocal omitted_images
        tag = local_name(node.tag)
        semantic_type = node.get("{http://www.idpf.org/2007/ops}type", "")
        if "pagebreak" in semantic_type.split() or node.get("role") == "doc-pagebreak":
            return
        if tag in SKIP_TAGS:
            return
        if tag in {"img", "image"}:
            omitted_images += 1
            return
        if tag in {"svg", "math"}:
            omitted_images += 1
            return
        block = tag in BLOCK_TAGS
        if block:
            flush()
        for name in (node.get("id"), node.get("{http://www.w3.org/XML/1998/namespace}id"), node.get("name") if tag == "a" else None):
            if name:
                anchors.setdefault(name, len(paragraphs))
        start = len(paragraphs)
        if tag == "br":
            buffer.append(" ")
        elif node.text:
            buffer.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                buffer.append(child.tail)
        if tag in {"td", "th"}:
            buffer.append(" ")
        if block:
            flush()
        end = len(paragraphs)
        if tag in {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "figcaption"}:
            classes = sorted({value for child in node.iter() for value in child.get("class", "").split()})
            for index in range(start, end):
                full_bold = any(local_name(child.tag) in {"strong", "b"} and normalise_text("".join(child.itertext())) == paragraphs[index] for child in node.iter())
                attributes.setdefault(index, {"tag": tag, "classes": classes, **({"fullBold": True} if full_bold else {})})
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and end > start:
            title = " ".join(paragraphs[start:end])
            if len(title) <= 250:
                headings[start] = title
        elif tag == "p" and end == start + 1:
            title = paragraphs[start]
            contains_large_type = any(large_classes.intersection(child.get("class", "").split()) for child in node.iter())
            if contains_large_type and len(title) <= 180 and len(WORD_RE.findall(title)) <= 28:
                inferred[start] = title

    walk(body)
    flush()
    return ExtractedText(paragraphs, anchors, headings, inferred, omitted_images, attributes)


def resolve_source(directory: Path, book_id: str, filename: str) -> Path:
    exact = directory / filename
    if exact.is_file():
        return exact
    matches = [
        path for path in directory.glob("*.epub")
        if any(title in re.sub(r"\s+", " ", path.stem.lower()) for title in TITLE_MATCHES[book_id])
    ]
    if len(matches) != 1:
        raise ImportFailure(f"{book_id}: expected one matching EPUB, found {len(matches)}")
    return matches[0]


def label_key(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    return "".join(character.casefold() for character in text if character.isalnum())


def display_title(text: str) -> str:
    text = normalise_text(text).replace("\u200b", "")
    for source, replacement in {
        "F OREWORD": "Foreword", "P ART O NE": "Part one",
        "P ART T WO": "Part two", "P ART T HREE": "Part three",
        "H ABIT": "Habit",
    }.items():
        text = text.replace(source, replacement)
    return text


def source_policy(book_id: str, path: str) -> str | None:
    """Only containers verified in these exact supplied editions are excluded."""
    name = posixpath.basename(path).lower()
    if book_id == "atomic-habits":
        if "copyright" in name:
            return "copyright and edition information"
        if "contents" in name:
            return "printed contents"
        if name == "next-reads.xhtml":
            return "publisher reading-list sign-up"
        if "about_the_author" in name or "what_should_you_read" in name or "how_to_apply_these_id" in name:
            return "author biography and promotional material"
    elif book_id == "five-am-club":
        if "copyright" in name:
            return "copyright and edition information"
        if "contents" in name:
            return "printed contents"
        if any(token in name for token in ("backmatter_1", "backmatter_2", "about_the_author", "about_the_publisher", "also_by")):
            return "author biography and promotional material"
    elif book_id == "rich-dad-poor-dad":
        if name == "copyright.xhtml":
            return "copyright and edition information"
        if name == "contents.xhtml":
            return "printed contents"
        if name.startswith("frontmatter") or name.startswith("backmatter") or name == "about_the_author.xhtml":
            return "praise, other-book lists and promotional material"
    elif book_id == "laws-of-power":
        if name.endswith("split_000.html"):
            return "title page"
        if name.endswith(("split_001.html", "split_052.html")):
            return "printed contents and duplicated law overview"
    elif book_id == "subconscious-mind":
        if name.endswith("split_000.html"):
            return "title page"
        if name.endswith("split_001.html"):
            return "copyright and edition information"
        if name.endswith("split_003.html"):
            return "printed contents"
    elif book_id == "seven-habits":
        if name.endswith("split_001.html"):
            return "copyright and edition information"
        if name.endswith(("split_005.html", "split_087.html")):
            return "printed contents"
        if name.endswith(("split_026.html", "split_042.html", "split_061.html", "split_084.html")):
            return "duplicate habit-title diagram pages"
    elif book_id == "power-of-now":
        if name in {"title.xhtml", "part1.xhtml"}:
            return "title pages"
        if name == "part104.xhtml":
            return "end marker"
    return None


def forced_section(book_id: str, path: str) -> str | None:
    name = posixpath.basename(path).lower()
    if book_id == "seven-habits":
        if name.endswith("split_002.html"):
            return "Dedication"
        if name.endswith("split_003.html"):
            return "Acknowledgements"
    if book_id == "subconscious-mind" and name.endswith("split_002.html"):
        return "How This Book Can Work Miracles in Your Life"
    if book_id == "atomic-habits" and "footnote" in name:
        return "Footnotes"
    return None


def heading_only(title: str, paragraphs: list[str], metadata: list[dict]) -> bool:
    if not paragraphs:
        return True
    joined = label_key(" ".join(paragraphs))
    key = label_key(title)
    if joined == key:
        return True
    if len(paragraphs) <= 3 and sum(len(WORD_RE.findall(p)) for p in paragraphs) <= 35:
        return all(meta.get("heading") or label_key(p) in key for p, meta in zip(paragraphs, metadata))
    return False


def clean_chapters(chapters: list[dict], book_id: str, book_title: str, source_info: dict, include_source: bool = False) -> tuple[list[dict], dict]:
    """Scan every paragraph, retaining the work rather than publication furniture."""
    before = {
        "sections": len(chapters),
        "paragraphs": sum(len(chapter["paragraphs"]) for chapter in chapters),
        "words": sum(len(WORD_RE.findall(p)) for chapter in chapters for p in chapter["paragraphs"]),
    }
    reasons: dict[str, dict] = {}
    removed_sections = 0
    merged_sections = 0
    moved_paragraphs = 0
    warnings = []

    def remove(reason: str, paragraph: str) -> None:
        item = reasons.setdefault(reason, {"paragraphs": 0, "words": 0})
        item["paragraphs"] += 1
        item["words"] += len(WORD_RE.findall(paragraph))

    title_keys = {label_key(book_title), label_key(re.sub(r"^The\s+", "", book_title, flags=re.I))}
    if book_id == "laws-of-power":
        title_keys.add(label_key("48 Laws of Power"))
    carnegie_start = None
    carnegie_promotion_start = None
    carnegie_biography_start = None
    if book_id == "win-friends":
        first_path = next(path for path in source_info if path.endswith("split_000.html"))
        carnegie_start = next((i for i, p in enumerate(source_info[first_path]["paragraphs"]) if re.fullmatch(r"preface", p, re.I)), None)
        if carnegie_start is None:
            raise ImportFailure("Expected Carnegie preface boundary was not found")
        last_path = next(path for path in source_info if path.endswith("split_003.html"))
        last_paragraphs = source_info[last_path]["paragraphs"]
        carnegie_promotion_start = next((i for i, p in enumerate(last_paragraphs) if p == "THE DALE CARNEGIE COURSES"), None)
        carnegie_biography_start = next((i for i, p in enumerate(last_paragraphs[:-2]) if p == "A Shortcut to" and last_paragraphs[i + 1] == "Distinction" and last_paragraphs[i + 2] == "by Lowell Thomas"), None)
        if carnegie_promotion_start is None or carnegie_biography_start is None or carnegie_promotion_start <= carnegie_biography_start:
            raise ImportFailure("Expected Carnegie biography and advertising boundaries were not found")
    sections = []
    for chapter in chapters:
        local_sections = []
        current = None
        for paragraph, meta in zip(chapter["paragraphs"], chapter["_source"]):
            path = meta["path"]
            index = meta["index"]
            reason = source_policy(book_id, path)
            if book_id == "win-friends" and path.endswith("split_000.html") and index < carnegie_start:
                reason = "praise, title pages and copyright information"
            if book_id == "win-friends" and path.endswith("split_003.html") and index >= carnegie_promotion_start:
                reason = "course advertising and other-book sales lists"
            if book_id == "atomic-habits" and posixpath.basename(path) == "42_Footnote.xhtml" and paragraph == "* Interested readers can learn more at habitsacademy.com.":
                reason = "training platform promotional footnote"
            if book_id == "atomic-habits" and (paragraph == "ABCDEFGHIJKLMNOPQRSTUVWXYZ" or paragraph.startswith("The page numbers in this index refer to the printed version of this book.")):
                reason = "EPUB index navigation strips and link instructions"
            # Book-name strings in the first two positions of every source
            # container are repeated running headers in these two editions.
            if not reason and book_id in {"laws-of-power", "power-of-now"} and index < 2 and label_key(paragraph) in title_keys:
                reason = "recurring book-title page headers"
            if not reason and paragraph == "\u00a4" and book_id == "power-of-now":
                reason = "decorative separator glyphs"
            if not reason and re.fullmatch(r"(?:https?://)?(?:www\.)?(?:z-lib(?:rary)?\.[\w.]+|1lib\.[\w.]+)\s*", paragraph, re.I):
                reason = "distribution watermark"
            if reason:
                remove(reason, paragraph)
                continue
            forced = forced_section(book_id, path)
            if book_id == "win-friends" and path.endswith("split_003.html") and carnegie_biography_start <= index < carnegie_promotion_start:
                forced = "A Shortcut to Distinction"
            section_title = forced or display_title(chapter["title"])
            if book_id == "win-friends" and label_key(section_title) == "dalecarnegie":
                section_title = "Preface and introduction"
            continuation = book_id == "seven-habits" and path.endswith("split_086.html")
            key = (section_title, forced is not None, continuation)
            if current is None or current["_key"] != key:
                current = {
                    "id": chapter["id"], "title": section_title,
                    "paragraphs": [], "_source": [], "_key": key,
                    "_continue": continuation,
                }
                if local_sections:
                    current["id"] = "c-" + hashlib.sha256(f"{chapter['id']}:{path}".encode()).hexdigest()[:12]
                local_sections.append(current)
            current["paragraphs"].append(paragraph)
            current["_source"].append(meta)
        if not local_sections:
            removed_sections += 1
        sections.extend(local_sections)

    result = []
    pending_titles = []
    chapter_counter = 0
    for section in sections:
        paragraphs = section["paragraphs"]
        metadata = section["_source"]
        next_context = []
        # These four Carnegie part dividers belong to the next chapter. Their
        # smaller styled headings were attached to the preceding body section.
        if book_id == "win-friends":
            for start in range(max(1, len(paragraphs) - 6), len(paragraphs)):
                part = label_key(paragraphs[start])
                if part in {"partone", "parttwo", "partthree", "partfour"} and all("calibre6" in meta.get("classes", []) for meta in metadata[start:]):
                    part_name = {"partone": "Part one", "parttwo": "Part two", "partthree": "Part three", "partfour": "Part four"}[part]
                    next_context.append(f"{part_name}: {' '.join(paragraphs[start + 1:])}")
                    for paragraph in paragraphs[start:]:
                        remove("part headings moved into the following chapter title", paragraph)
                    paragraphs = paragraphs[:start]
                    metadata = metadata[:start]
                    break
        # This EPUB's contents label is shortened, but its actual heading is
        # complete. Keep the source heading rather than the literal ellipsis.
        if book_id == "power-of-now" and section["title"].endswith("..."):
            shortened = label_key(section["title"][:-3])
            matches = [p for p, meta in zip(paragraphs[:3], metadata[:3]) if meta.get("heading") and label_key(p).startswith(shortened)]
            if len(matches) != 1:
                raise ImportFailure("A shortened Power of Now heading cannot be recovered safely")
            section["title"] = matches[0]
        if section["_continue"]:
            if not result or not label_key(result[-1]["title"]).startswith("habit4"):
                raise ImportFailure("Incomplete Covey continuation has no Habit 4 section")
            result[-1]["paragraphs"].extend(paragraphs)
            result[-1]["_source"].extend(metadata)
            moved_paragraphs += len(paragraphs)
            merged_sections += 1
            continue
        if heading_only(section["title"], paragraphs, metadata):
            pending_titles.append(section["title"])
            for paragraph in paragraphs:
                remove("divider headings moved into the following section title", paragraph)
            merged_sections += 1
            continue

        title = section["title"]
        if book_id == "five-am-club" and re.match(r"^\d+\. ", title):
            number, subtitle = title.split(". ", 1)
            if len(paragraphs) < 3 or paragraphs[0] != f"Chapter {number}" or label_key(paragraphs[1]) != label_key(subtitle):
                raise ImportFailure("A 5 AM Club chapter has no verified repeated heading blocks")
            for paragraph in paragraphs[:2]:
                remove("chapter headings moved into the reader title", paragraph)
            paragraphs = paragraphs[2:]
            metadata = metadata[2:]
        if book_id == "seven-habits" and paragraphs:
            duplicate_acknowledgements = title == "Acknowledgements" and paragraphs[0] == "ACKNOWLEDGMENTS"
            duplicate_principles = paragraphs[0].startswith("PRINCIPLES OF ") and label_key(title).endswith(label_key(paragraphs[0]))
            if duplicate_acknowledgements or duplicate_principles:
                remove("chapter headings moved into the reader title", paragraphs[0])
                paragraphs = paragraphs[1:]
                metadata = metadata[1:]
        # Carnegie's large numerals introduce titles printed in smaller type.
        if book_id == "win-friends" and title.isdigit():
            heading_parts = []
            count = 0
            for paragraph, meta in zip(paragraphs[:8], metadata[:8]):
                if count == 0 and paragraph == title:
                    count += 1
                    continue
                if {"bold", "calibre4"}.issubset(meta.get("classes", [])) and len(paragraph) <= 180:
                    heading_parts.append(paragraph)
                    count += 1
                else:
                    break
            if heading_parts:
                title = f"{title}. {' '.join(heading_parts)}"
                for paragraph in paragraphs[:count]:
                    remove("chapter headings moved into the reader title", paragraph)
                paragraphs = paragraphs[count:]
                metadata = metadata[count:]
            else:
                raise ImportFailure("A Carnegie chapter number has no verified title lines")
        elif book_id == "laws-of-power" and re.fullmatch(r"LAW \d+", title, re.I):
            judgment = next((i for i, p in enumerate(paragraphs[:12]) if p == "JUDGMENT"), None)
            if judgment is None or judgment < 2 or label_key(paragraphs[0]) != label_key(title) or any(len(p) > 180 for p in paragraphs[1:judgment]):
                raise ImportFailure("A law heading has no verified JUDGMENT boundary")
            title = f"{title.title()}: {' '.join(paragraphs[1:judgment])}"
            for paragraph in paragraphs[:judgment]:
                remove("chapter headings moved into the reader title", paragraph)
            paragraphs = paragraphs[judgment:]
            metadata = metadata[judgment:]

        # A contents label may consist of several consecutive heading blocks.
        title_key = label_key(title)
        matched = 0
        for count in range(1, min(len(paragraphs), 6) + 1):
            prefix_key = label_key(" ".join(paragraphs[:count]))
            if prefix_key == title_key:
                matched = count
                break
            if not title_key.startswith(prefix_key):
                break
        if not matched and paragraphs and metadata[0].get("heading"):
            first_key = label_key(paragraphs[0])
            if len(first_key) > 6 and (first_key.startswith(title_key) or title_key.startswith(first_key)):
                title = paragraphs[0]
                matched = 1
        for paragraph in paragraphs[:matched]:
            remove("chapter headings moved into the reader title", paragraph)
        paragraphs = paragraphs[matched:]
        metadata = metadata[matched:]
        if not paragraphs:
            pending_titles.append(title)
            merged_sections += 1
            continue
        if pending_titles:
            context = []
            for pending in pending_titles:
                if re.fullmatch(r"Chapter\s+\w+", pending, re.I) and book_id == "power-of-now":
                    chapter_counter += 1
                    pending = f"Chapter {chapter_counter}"
                if label_key(pending) != label_key(title) and pending not in context:
                    context.append(pending)
            if context:
                title = " / ".join(context + [title])
            pending_titles.clear()

        cleaned_paragraphs = []
        cleaned_meta = []
        for paragraph, meta in zip(paragraphs, metadata):
            if cleaned_paragraphs and paragraph == cleaned_paragraphs[-1]:
                # This edition repeats a pull quote immediately as body text.
                if book_id == "rich-dad-poor-dad" and "poem" in cleaned_meta[-1].get("classes", []):
                    remove("duplicate pull quote immediately repeated in body text", cleaned_paragraphs.pop())
                    cleaned_meta.pop()
                else:
                    raise ImportFailure("Unclassified consecutive repeated text requires inspection")
            cleaned_paragraphs.append(paragraph)
            cleaned_meta.append(meta)
        section["title"] = title
        section["paragraphs"] = cleaned_paragraphs
        section["_source"] = cleaned_meta
        result.append(section)
        pending_titles.extend(next_context)
    if pending_titles:
        raise ImportFailure("Unresolved title-only pages remain at the end")
    if not result:
        raise ImportFailure("Cleanup removed all readable sections")
    all_paragraphs = [p for chapter in result for p in chapter["paragraphs"]]
    for chapter in result:
        if not chapter["paragraphs"] or heading_only(chapter["title"], chapter["paragraphs"], chapter["_source"]):
            raise ImportFailure("Cleanup left an empty or heading-only section")
    if any(a == b for a, b in zip(all_paragraphs, all_paragraphs[1:])):
        raise ImportFailure("Cleanup left consecutive duplicate paragraphs")
    if book_id == "seven-habits":
        warnings.append("The supplied edition ends during Habit 4. Habits 5 to 7 and later material are absent; erroneous later contents targets were removed.")
    if book_id == "laws-of-power":
        warnings.append("The supplied EPUB contains OCR spelling and spacing errors. Source wording is retained rather than guessed.")
    after = {
        "sections": len(result), "paragraphs": len(all_paragraphs),
        "words": sum(len(WORD_RE.findall(p)) for p in all_paragraphs),
    }
    report = {
        "before": before, "after": after,
        "removedSections": removed_sections, "mergedSections": merged_sections,
        "removedParagraphs": before["paragraphs"] - after["paragraphs"],
        "removedWords": before["words"] - after["words"],
        "movedContinuationParagraphs": moved_paragraphs,
        "reasons": reasons, "warnings": warnings,
        "checks": {"allParagraphsScanned": True, "noEmptySections": True, "noHeadingOnlySections": True, "noConsecutiveExactDuplicates": True},
    }
    if sum(reason["paragraphs"] for reason in reasons.values()) != report["removedParagraphs"]:
        raise ImportFailure("Cleanup paragraph accounting does not balance")
    if sum(reason["words"] for reason in reasons.values()) != report["removedWords"]:
        raise ImportFailure("Cleanup word accounting does not balance")
    return [{"id": c["id"], "title": c["title"], "paragraphs": c["paragraphs"], **({"_source": c["_source"]} if include_source else {})} for c in result], report


def import_book(source: Path, book_id: str, book_title: str, include_source: bool = False) -> tuple[dict, dict, dict]:
    if source.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ImportFailure("EPUB exceeds the archive size limit")
    digest = hashlib.sha256((PARSER_VERSION + "\0").encode())
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    edition_id = digest.hexdigest()[:16]
    archive = SafeArchive(source)
    try:
        container = parse_xml(archive.read("META-INF/container.xml"))
        rootfiles = [node.get("full-path") for node in container.iter() if local_name(node.tag) == "rootfile"]
        if len(rootfiles) != 1 or not rootfiles[0]:
            raise ImportFailure("EPUB must identify one package document")
        opf_path, _ = resource_path("", rootfiles[0])
        opf = parse_xml(archive.read(opf_path))
        manifest_node = next((node for node in opf if local_name(node.tag) == "manifest"), None)
        spine_node = next((node for node in opf if local_name(node.tag) == "spine"), None)
        if manifest_node is None or spine_node is None:
            raise ImportFailure("EPUB is missing a manifest or reading order")
        manifest = {}
        for item in manifest_node:
            item_id = item.get("id")
            if not item_id or item_id in manifest or not item.get("href"):
                raise ImportFailure("Malformed EPUB manifest")
            path, _ = resource_path(opf_path, item.get("href", ""))
            manifest[item_id] = {"path": path, "type": item.get("media-type", ""), "properties": item.get("properties", "")}
        toc = []
        for item in manifest.values():
            if item["type"] == "application/x-dtbncx+xml":
                toc.extend(read_toc(archive, item["path"]))
        css = "\n".join(archive.read(item["path"]).decode("utf-8", "replace") for item in manifest.values() if item["type"] == "text/css")
        large_classes = large_type_classes(css)
        chapters = []
        source_info = {}
        omitted_images = 0
        for spine_index, reference in enumerate(spine_node):
            if local_name(reference.tag) != "itemref":
                continue
            item = manifest.get(reference.get("idref", ""))
            if item is None:
                raise ImportFailure("Reading order references an unknown item")
            if item["type"] not in {"application/xhtml+xml", "text/html"}:
                raise ImportFailure("Unsupported reading-order resource type")
            if "nav" in item["properties"].split():
                continue
            text_root = parse_xml(archive.read(item["path"]))
            if book_id == "win-friends":
                join_wrapped_lines(text_root, css, large_classes)
            extracted = extract_text(text_root, large_classes)
            source_info[item["path"]] = {"paragraphs": extracted.paragraphs}
            origins = [
                {
                    "path": item["path"], "index": index,
                    "heading": index in extracted.headings or index in extracted.inferred_headings,
                    **extracted.paragraph_attributes.get(index, {}),
                }
                for index in range(len(extracted.paragraphs))
            ]
            omitted_images += extracted.omitted_images
            if not extracted.paragraphs:
                continue
            breaks: dict[int, tuple[str, int]] = {}
            for target in toc:
                if target.path != item["path"]:
                    continue
                index = extracted.anchors.get(target.anchor) if target.anchor else 0
                if index is not None and index < len(extracted.paragraphs):
                    if index not in breaks or breaks[index][1] <= target.depth:
                        breaks[index] = (target.title, target.depth)
            if len(toc) < 3:
                candidates = extracted.headings or extracted.inferred_headings
                for index, title in candidates.items():
                    breaks.setdefault(index, (title, 0))
            if 0 not in breaks:
                prefix_end = min(breaks) if breaks else len(extracted.paragraphs)
                if chapters:
                    # A spine resource is a storage boundary, not a chapter.
                    # Keep the current chapter until the next contents target.
                    chapters[-1]["paragraphs"].extend(extracted.paragraphs[:prefix_end])
                    chapters[-1]["_source"].extend(origins[:prefix_end])
                else:
                    first_heading = extracted.headings.get(0) or extracted.inferred_headings.get(0)
                    breaks[0] = (first_heading or book_title, 0)
            positions = sorted(breaks)
            for number, start in enumerate(positions):
                end = positions[number + 1] if number + 1 < len(positions) else len(extracted.paragraphs)
                paragraphs = extracted.paragraphs[start:end]
                if not paragraphs:
                    continue
                section_key = f"{edition_id}:{spine_index}:{start}"
                chapter_id = "c-" + hashlib.sha256(section_key.encode()).hexdigest()[:12]
                chapters.append({"id": chapter_id, "title": breaks[start][0], "paragraphs": paragraphs, "_source": origins[start:end]})
        if not chapters:
            raise ImportFailure("EPUB has no readable text")
        chapters, cleanup_report = clean_chapters(chapters, book_id, book_title, source_info, **({"include_source": True} if include_source else {}))
        paragraph_count = sum(len(chapter["paragraphs"]) for chapter in chapters)
        word_count = sum(len(WORD_RE.findall(paragraph)) for chapter in chapters for paragraph in chapter["paragraphs"])
        if word_count < 100:
            raise ImportFailure("EPUB has too little readable text")
        content = {"editionId": edition_id, "chapters": chapters}
        stats = {
            "editionId": edition_id,
            "wordCount": word_count,
            "readingMinutes": math.ceil(word_count / 250),
            "chapterCount": len(chapters),
            "paragraphCount": paragraph_count,
            "omittedImageCount": omitted_images,
        }
        if book_id == "seven-habits":
            stats["isComplete"] = False
            stats["availabilityNote"] = "The supplied file ends during Habit 4. Habits 5 to 7 are missing."
        return content, stats, cleanup_report
    finally:
        archive.close()


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads", help="Directory containing the eight EPUB files")
    args = parser.parse_args()
    if not args.source_dir.is_dir():
        parser.error("The EPUB source directory does not exist")
    results = {}
    pending = {}
    cleanup_reports = {}
    try:
        for book_id, (title, filename) in BOOKS.items():
            source = resolve_source(args.source_dir, book_id, filename)
            content, stats, report = import_book(source, book_id, title)
            pending[book_id] = content
            results[book_id] = stats
            cleanup_reports[book_id] = report
    except (ImportFailure, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Import stopped for {book_id}: {error}\n")
    for book_id, content in pending.items():
        write_json(PROJECT_ROOT / ".local" / "books" / f"{book_id}.json", content)
    write_json(PROJECT_ROOT / "src" / "data" / "imported-books.json", results)
    write_json(PROJECT_ROOT / ".local" / "cleanup-report.json", {"parserVersion": PARSER_VERSION, "books": cleanup_reports})
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
