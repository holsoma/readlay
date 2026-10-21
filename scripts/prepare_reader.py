"""Prepare private reader presentation metadata without changing canonical books.

Run with Python 3.10+ and Pillow installed:
    python scripts/prepare_reader.py --source-dir PATH_TO_EPUB_DIRECTORY

Outputs stay in .local/reader and .local/book-assets. Source text, editions,
paragraph order and word coordinates in .local/books are never rewritten.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
from pathlib import Path
import re
import warnings
import xml.etree.ElementTree as ET

try:
    from . import import_books as importer
except ImportError:
    import import_books as importer

MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_BYTES = 20 * 1024 * 1024
WORD_PATTERN = re.compile(r"(?:\d+(?:[,.]\d+)+|[^\W_]+(?:['’\-‐‑][^\W_]+)*)", re.UNICODE)
CORRECTION_CONFIG_PATH = importer.PROJECT_ROOT / "src/data/reader-corrections.json"
IMAGE_DESCRIPTION_PATH = importer.PROJECT_ROOT / "src/data/reader-image-descriptions.json"


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def load_corrections() -> dict:
    if not CORRECTION_CONFIG_PATH.is_file():
        return {}
    config = json.loads(CORRECTION_CONFIG_PATH.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise importer.ImportFailure("Reader correction configuration must be an object")
    return config


def valid_replacement(text: object) -> bool:
    return isinstance(text, str) and 0 < len(text) <= 160 and bool(text.strip()) and not re.search(r"[<>\x00-\x1f\x7f]", text)


def reviewed_rules(config: dict, book_id: str, edition_id: str) -> dict:
    reviewed = config.get(book_id, {})
    if not isinstance(reviewed, dict):
        raise importer.ImportFailure("Reader correction book configuration must be an object")
    if reviewed.get("editionId") != edition_id:
        return {}
    tokens, occurrences = reviewed.get("tokens", {}), reviewed.get("occurrences", [])
    if not isinstance(tokens, dict) or not isinstance(occurrences, list):
        raise importer.ImportFailure("Reader correction token and occurrence collections are invalid")
    for source, replacement in tokens.items():
        if not isinstance(source, str) or source != source.casefold() or not WORD_PATTERN.fullmatch(source) or not valid_replacement(replacement):
            raise importer.ImportFailure("Reader token correction must match one lower-case canonical word")
    if any(not isinstance(entry, dict) for entry in occurrences):
        raise importer.ImportFailure("Reader occurrence correction must be an object")
    return reviewed


def corrections_for(text: str, book_id: str, edition_id: str, chapter_index: int = 0, paragraph_index: int = 0, config: dict | None = None) -> list[dict]:
    reviewed = reviewed_rules(load_corrections() if config is None else config, book_id, edition_id)
    if not reviewed:
        return []
    corrections = {}
    words = {}
    for match in WORD_PATTERN.finditer(text):
        source = match.group()
        start, end = utf16_length(text[:match.start()]), utf16_length(text[:match.end()])
        words[(start, end)] = source
        replacement = reviewed.get("tokens", {}).get(source.casefold())
        if replacement is None:
            continue
        if not valid_replacement(replacement):
            raise importer.ImportFailure("Reader correction replacement is invalid")
        if source.isupper():
            replacement = replacement.upper()
        elif source.istitle():
            replacement = replacement[0].upper() + replacement[1:]
        elif not source.islower():
            continue
        corrections[(start, end)] = {"charStart": start, "charEnd": end, "sourceText": source, "replacementText": replacement}
    for entry in reviewed.get("occurrences", []):
        if entry.get("chapterIndex") != chapter_index or entry.get("paragraphIndex") != paragraph_index:
            continue
        key = (entry.get("charStart"), entry.get("charEnd"))
        if key not in words or words[key] != entry.get("sourceText") or not valid_replacement(entry.get("replacementText")):
            raise importer.ImportFailure("Reader occurrence correction does not match one complete canonical word")
        corrections[key] = {field: entry[field] for field in ("charStart", "charEnd", "sourceText", "replacementText")}
    return [corrections[key] for key in sorted(corrections)]


def validate_book_occurrences(config: dict, book_id: str, canonical: dict) -> None:
    reviewed = reviewed_rules(config, book_id, canonical["editionId"])
    seen = set()
    for entry in reviewed.get("occurrences", []):
        ci, pi = entry.get("chapterIndex"), entry.get("paragraphIndex")
        if type(ci) is not int or type(pi) is not int or ci < 0 or ci >= len(canonical["chapters"]) or pi < 0 or pi >= len(canonical["chapters"][ci]["paragraphs"]):
            raise importer.ImportFailure("Reader occurrence correction has invalid chapter or paragraph coordinates")
        start, end = entry.get("charStart"), entry.get("charEnd")
        if type(start) is not int or type(end) is not int or start < 0 or end <= start:
            raise importer.ImportFailure("Reader occurrence correction has invalid UTF16 coordinates")
        identity = (ci, pi, start)
        if identity in seen:
            raise importer.ImportFailure("Reader occurrence correction is duplicated")
        seen.add(identity)
        text = canonical["chapters"][ci]["paragraphs"][pi]
        corrections_for(text, book_id, canonical["editionId"], ci, pi, config)


def corrected_display_text(text: str, corrections: list[dict]) -> str:
    encoded = text.encode("utf-16-le")
    for correction in reversed(corrections):
        start, end = correction["charStart"] * 2, correction["charEnd"] * 2
        if encoded[start:end].decode("utf-16-le") != correction["sourceText"]:
            raise importer.ImportFailure("A display correction no longer matches its source")
        encoded = encoded[:start] + correction["replacementText"].encode("utf-16-le") + encoded[end:]
    return encoded.decode("utf-16-le")


def paragraph_kind(text: str, source: dict, book_id: str, paragraph_index: int) -> str:
    tag = source.get("tag", "")
    source_classes = set(source.get("classes", []))
    classes = " ".join(source_classes).lower()
    if tag in {"h1", "h2"}:
        return "heading"
    if tag in {"h3", "h4", "h5", "h6"}:
        return "subheading"
    if tag == "figcaption" or re.search(r"caption|figcap", classes):
        return "caption"
    if book_id == "atomic-habits":
        if "x08-Table-Title" in source_classes:
            return "caption"
        if {"x06-Chapter-Summary-Head", "x13-BM-Index-Alpha"}.intersection(source_classes):
            return "subheading"
        if any(re.fullmatch(r"x06-(?:Verse(?:-First|-Last)?|Extract(?:-1P|-First|-Last)?)", value) for value in source_classes):
            return "quote"
    if book_id == "rich-dad-poor-dad" and {"subheading", "subheadingk", "boxtitle", "boxtitlec"}.intersection(source_classes):
        return "subheading"
    if book_id == "subconscious-mind" and source.get("fullBold") and len(text) <= 180 and not re.match(r"^\d+[.)]\s", text):
        return "subheading"
    if book_id == "five-am-club":
        if "a_hd" in source_classes:
            return "heading"
        if {"b_hd", "rule_hd"}.intersection(source_classes):
            return "subheading"
        if {"list", "list1", "list_l"}.intersection(source_classes):
            return "list-item"
        if {"epi", "epi1", "ext", "ext1", "ext_l"}.intersection(source_classes):
            return "quote"
    if book_id == "win-friends" and "calibre4" in source_classes and (re.fullmatch(r"PRINCIPLE \d+", text) or ("calibre3" in source_classes and text.isupper()) or text in {"FATHER FORGETS", "THE VALUE OF A SMILE AT CHRISTMAS"}):
        return "subheading"
    if book_id == "laws-of-power" and re.fullmatch(r"(?:c\.\s*)?(?:(?:a\.?\s*d\.?|b\.?\s*c\.?)\s*)?\d{1,4}\s*[-–‐‑]\s*\d{1,4}(?:\s*(?:a\.?\s*d\.?|b\.?\s*c\.?))?", text, re.I):
        return "body"
    if tag == "li" or re.search(r"bullet|list[-_]item", classes) or re.match(r"^(?:[•●▪]|\d+[.)]\s|[a-z][.)]\s)", text):
        return "list-item"
    if tag == "blockquote" or re.search(r"quote|epigraph|poem|(?:^|\s)cn_epi(?:\s|$)", classes):
        return "quote"
    if book_id == "rich-dad-poor-dad" and paragraph_index == 0 and "centerm" in classes and len(text) < 300:
        return "quote"
    if book_id == "laws-of-power" and (text in {"JUDGMENT", "REVERSAL", "KEYS TO POWER", "INTERPRETATION"} or re.fullmatch(r"(?:OBSERVANCE|TRANSGRESSION)(?: AND OBSERVANCE)? OF THE LAW(?: [IVX]+)?", text)):
        return "subheading"
    if book_id == "seven-habits" and text.isupper() and len(text) < 160 and "bold" in source.get("classes", []) and {"calibre29", "calibre38"}.intersection(source.get("classes", [])):
        return "subheading"
    if book_id == "power-of-now" and text.isupper() and len(text) < 160 and "calibre4" in source.get("classes", []):
        return "subheading"
    if source.get("heading"):
        return "subheading"
    return "body"


def image_description(book_id: str, resource: str, source_alt: str, title: str, chapter_title: str, config: dict) -> str:
    descriptions = config.get(book_id, {})
    if not isinstance(descriptions, dict):
        raise importer.ImportFailure("Reader image descriptions must be an object")
    reviewed = descriptions.get(Path(resource).name)
    if reviewed is not None:
        if not isinstance(reviewed, str) or not reviewed.strip() or len(reviewed) > 1000 or re.search(r"[<>\x00-\x1f\x7f]", reviewed):
            raise importer.ImportFailure("Reader image description is invalid")
        return reviewed
    cleaned = importer.normalise_text(re.sub(r"[\x00-\x1f\x7f]", "", source_alt))[:600]
    return cleaned if cleaned and not re.search(r"\.(?:jpe?g|png|webp)$", cleaned, re.I) and cleaned.lower() not in {"image", "figure", "img"} else f"Figure from {title}: {chapter_title}"


def image_events(root: ET.Element) -> tuple[list[str], list[dict]]:
    """Mirror the importer's text boundaries while retaining skipped images."""
    body = next((n for n in root.iter() if importer.local_name(n.tag) == "body"), None)
    if body is None:
        raise importer.ImportFailure("EPUB text resource has no body")
    paragraphs, buffer, events = [], [], []
    def flush():
        text = importer.normalise_text("".join(buffer)); buffer.clear()
        if text:
            paragraphs.append(text)
    def walk(node):
        tag = importer.local_name(node.tag)
        semantic = node.get("{http://www.idpf.org/2007/ops}type", "")
        if "pagebreak" in semantic.split() or node.get("role") == "doc-pagebreak" or tag in importer.SKIP_TAGS:
            return
        if tag in {"img", "image", "svg", "math"}:
            href = node.get("src") or node.get("href") or node.get("{http://www.w3.org/1999/xlink}href")
            if not href and tag == "svg":
                child = next((n for n in node.iter() if importer.local_name(n.tag) == "image"), None)
                if child is not None:
                    href = child.get("href") or child.get("{http://www.w3.org/1999/xlink}href")
            events.append({"tag": tag, "href": href, "alt": node.get("alt", ""), "sourceParagraphBoundary": len(paragraphs), "inline": bool(importer.normalise_text("".join(buffer)))})
            return
        block = tag in importer.BLOCK_TAGS
        if block:
            flush()
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
    walk(body); flush()
    return paragraphs, events


def meaningful_image(book_id: str, resource: str, source_document: str, is_cover: bool) -> bool:
    if is_cover:
        return False
    policy = importer.source_policy(book_id, source_document)
    if policy and policy != "duplicate habit-title diagram pages":
        return False
    name = Path(resource).name.lower()
    if re.search(r"cover|titlepage|^title\.|^halftitle\.|logo|^copy\.|^line\.|^short\.|^sb_image|revised_dots", name):
        return False
    if book_id == "atomic-habits":
        return bool(re.match(r"^\d{3}_", name) or name in {"fig12_071218.jpg", "invalid_page_number.jpg"})
    if book_id == "seven-habits":
        return bool(re.fullmatch(r"\d{5}\.jpe?g", name))
    if book_id == "rich-dad-poor-dad":
        return bool(re.fullmatch(r"f\d{4}-01a?\.jpe?g", name))
    if book_id == "five-am-club":
        return name.startswith("5_am_book_outlines") or name.startswith("chalk-") or bool(re.fullmatch(r"s0[1-6]\.jpe?g", name))
    return False


def raster_asset(data: bytes) -> tuple[bytes, int, int]:
    if len(data) > MAX_IMAGE_BYTES:
        raise importer.ImportFailure("Reader image exceeds the byte limit")
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise importer.ImportFailure("Image preparation requires a Python environment with Pillow installed") from error
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"} or image.width <= 0 or image.height <= 0 or image.width * image.height > MAX_IMAGE_PIXELS:
                    raise importer.ImportFailure("Reader image is not a supported raster within the pixel limit")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                image = ImageOps.exif_transpose(image)
                if "A" in image.getbands() or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    flattened = Image.new("RGB", rgba.size, "white")
                    flattened.paste(rgba, mask=rgba.getchannel("A"))
                    image = flattened
                else:
                    image = image.convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=90, optimize=True)
                return output.getvalue(), image.width, image.height
    except importer.ImportFailure:
        raise
    except Exception as error:
        raise importer.ImportFailure("Reader image failed raster validation") from error


def image_placement(event: dict, paragraph_sources: list[dict], source_order: dict[str, int]) -> tuple[int, int] | None:
    event_order = (event["spineIndex"], event["sourceParagraphBoundary"])
    following = next((p for p in paragraph_sources if (source_order[p["path"]], p["index"]) >= event_order), None)
    if following:
        inside = event["inline"] and following["path"] == event["sourceDocument"] and following["index"] == event["sourceParagraphBoundary"]
        return following["chapterIndex"], following["paragraphIndex"] + int(inside)
    if paragraph_sources:
        last = paragraph_sources[-1]
        return last["chapterIndex"], last["paragraphIndex"] + 1
    return None


def prepare_book(book_id: str, title: str, source: Path, canonical: dict, asset_root: Path) -> tuple[dict, dict, list[dict]]:
    enriched, _, _ = importer.import_book(source, book_id, title, include_source=True)
    stripped = {"editionId": enriched["editionId"], "chapters": [{k: v for k, v in chapter.items() if k != "_source"} for chapter in enriched["chapters"]]}
    if stripped != canonical:
        raise importer.ImportFailure(f"{book_id}: source does not reproduce the current canonical book")
    manifest = {"version": 1, "bookId": book_id, "editionId": canonical["editionId"], "chapters": []}
    counts = collections.Counter()
    config = load_corrections()
    validate_book_occurrences(config, book_id, canonical)
    descriptions = json.loads(IMAGE_DESCRIPTION_PATH.read_text(encoding="utf-8")) if IMAGE_DESCRIPTION_PATH.is_file() else {}
    if not isinstance(descriptions, dict):
        raise importer.ImportFailure("Reader image descriptions must be an object")
    paragraph_sources = []
    for ci, chapter in enumerate(enriched["chapters"]):
        presentation = {"paragraphs": {}, "images": []}
        title_corrections = corrections_for(chapter["title"], book_id, canonical["editionId"], ci, -1, config)
        if title_corrections:
            presentation["title"] = corrected_display_text(chapter["title"], title_corrections)
            counts["correctedTitles"] += 1
        for pi, (text, source_meta) in enumerate(zip(chapter["paragraphs"], chapter["_source"])):
            kind = paragraph_kind(text, source_meta, book_id, pi)
            corrections = corrections_for(text, book_id, canonical["editionId"], ci, pi, config)
            if kind != "body" or corrections:
                presentation["paragraphs"][str(pi)] = {"kind": kind, **({"corrections": corrections} if corrections else {})}
            counts[kind] += 1
            counts["corrections"] += len(corrections)
            paragraph_sources.append({**source_meta, "chapterIndex": ci, "paragraphIndex": pi})
        manifest["chapters"].append(presentation)
    archive = importer.SafeArchive(source)
    try:
        container = importer.parse_xml(archive.read("META-INF/container.xml"))
        opf_path = next(n.get("full-path") for n in container.iter() if importer.local_name(n.tag) == "rootfile")
        opf = importer.parse_xml(archive.read(opf_path))
        manifest_node = next(n for n in opf if importer.local_name(n.tag) == "manifest")
        spine = next(n for n in opf if importer.local_name(n.tag) == "spine")
        resources = {n.get("id"): {"path": importer.resource_path(opf_path, n.get("href"))[0], "type": n.get("media-type", ""), "properties": n.get("properties", "")} for n in manifest_node}
        cover_ids = {n.get("content") for n in opf.iter() if importer.local_name(n.tag) == "meta" and n.get("name") == "cover"}
        covers = {item["path"] for key, item in resources.items() if key in cover_ids or "cover-image" in item["properties"]}
        media = {item["path"]: item for item in resources.values()}
        css = "\n".join(archive.read(item["path"]).decode("utf-8", "replace") for item in resources.values() if item["type"] == "text/css")
        large = importer.large_type_classes(css)
        source_order = {resources[n.get("idref")]["path"]: i for i, n in enumerate(spine)}
        image_map, prepared, placements = [], {}, set()
        for spine_index, reference in enumerate(spine):
            item = resources[reference.get("idref")]
            path = item["path"]
            if item["type"] not in {"application/xhtml+xml", "text/html"} or "nav" in item["properties"].split():
                continue
            root = importer.parse_xml(archive.read(path))
            if book_id == "win-friends":
                importer.join_wrapped_lines(root, css, large)
            paragraphs, events = image_events(root)
            if paragraphs != importer.extract_text(root, large).paragraphs:
                raise importer.ImportFailure("Image and canonical source boundaries disagree")
            for event in events:
                counts["sourceImageOccurrences"] += 1
                if not event["href"]:
                    continue
                resource, _ = importer.resource_path(path, event["href"])
                if not meaningful_image(book_id, resource, path, resource in covers):
                    continue
                if resource not in media or not media[resource]["type"].startswith("image/"):
                    raise importer.ImportFailure("Figure does not reference a declared image resource")
                event.update({"spineIndex": spine_index, "sourceDocument": path})
                placement = image_placement(event, paragraph_sources, source_order)
                if placement is None:
                    continue
                if resource not in prepared:
                    data, width, height = raster_asset(archive.read(resource))
                    asset_id = hashlib.sha256(data).hexdigest()
                    target = asset_root / book_id / f"{asset_id}.jpg"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if not target.exists() or target.read_bytes() != data:
                        target.write_bytes(data)
                    prepared[resource] = {"id": asset_id, "filename": target.name, "mediaType": "image/jpeg", "width": width, "height": height}
                ci, boundary = placement
                asset = prepared[resource]
                duplicate = (ci, boundary, asset["id"])
                if duplicate in placements:
                    continue
                placements.add(duplicate)
                descriptive_alt = image_description(book_id, resource, event["alt"], title, canonical['chapters'][ci]['title'], descriptions)
                manifest["chapters"][ci]["images"].append({**asset, "beforeParagraph": boundary, "alt": descriptive_alt})
                image_map.append({"id": asset["id"], "resource": resource, "sourceDocument": path, "sourceParagraphBoundary": event["sourceParagraphBoundary"], "chapterIndex": ci, "beforeParagraph": boundary, "inlineSource": event["inline"]})
        for chapter in manifest["chapters"]:
            chapter["images"].sort(key=lambda image: image["beforeParagraph"])
        counts["restoredImageOccurrences"] = len(image_map)
        counts["restoredImageAssets"] = len({n["id"] for n in image_map})
    finally:
        archive.close()
    return manifest, dict(counts), [{"paragraphs": paragraph_sources}, {"images": image_map}]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--book", choices=tuple(importer.BOOKS), action="append", help="Prepare only selected books; default is all eight")
    args = parser.parse_args()
    selected = args.book or list(importer.BOOKS)
    canonical_paths = {bid: importer.PROJECT_ROOT / ".local/books" / f"{bid}.json" for bid in selected}
    hashes = {bid: hashlib.sha256(path.read_bytes()).hexdigest() for bid, path in canonical_paths.items()}
    manifests, summary, sources = {}, {}, {}
    try:
        for book_id in selected:
            title, filename = importer.BOOKS[book_id]
            source = importer.resolve_source(args.source_dir, book_id, filename)
            canonical = json.loads(canonical_paths[book_id].read_text(encoding="utf-8"))
            manifest, counts, source_map = prepare_book(book_id, title, source, canonical, importer.PROJECT_ROOT / ".local/book-assets")
            manifests[book_id] = manifest
            summary[book_id] = {"editionId": canonical["editionId"], **counts}
            sources[book_id] = source_map
        if hashes != {bid: hashlib.sha256(path.read_bytes()).hexdigest() for bid, path in canonical_paths.items()}:
            raise importer.ImportFailure("Canonical content changed while presentation was prepared")
        for book_id, manifest in manifests.items():
            importer.write_json(importer.PROJECT_ROOT / ".local/reader" / f"{book_id}.json", manifest)
        audit_dir = importer.PROJECT_ROOT / ".local/dictionary-qa/content-audit"
        importer.write_json(audit_dir / "presentation-summary.json", summary)
        importer.write_json(audit_dir / "presentation-source-map.json", sources)
        importer.write_json(audit_dir / "presentation-canonical-hashes.json", hashes)
    except (importer.ImportFailure, OSError, ValueError, KeyError, StopIteration) as error:
        parser.exit(1, f"Reader preparation stopped: {error}\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
