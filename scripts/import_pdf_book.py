"""Stage the reviewed Seven Habits PDF without replacing an active edition.

Requires pypdf, pdfplumber and Pillow. All book text, images and provenance are
written below .local/pdf-import/seven-habits. Nothing is published by this tool.
The PDF is data only: annotations, scripts, links and embedded files are ignored.
"""
from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass, field
import hashlib
import io
import json
import math
from pathlib import Path
import re
import unicodedata

import pdfplumber
from PIL import Image, ImageDraw
from pypdf import PdfReader

try:
    from . import import_books as importer
except ImportError:
    import import_books as importer


PARSER_VERSION = "readlay-seven-habits-pdf-v4"
BOOK_ID = "seven-habits"
TITLE = "The 7 Habits of Highly Effective People"
MAX_SOURCE_BYTES = 32 * 1024 * 1024
DEFAULT_OUTPUT = importer.PROJECT_ROOT / ".local/pdf-import/seven-habits"
MAX_IMAGE_PIXELS = 40_000_000
# This is a reviewed edition profile, not a guess based on arbitrary PDF pages.
# The PDF outline is checked before these page choices are accepted.
SECTIONS = [
    (17, "Dedication"),
    (18, "Acknowledgments"),
    (22, "Foreword to the 25th Anniversary Edition by Jim Collins"),
    (27, "A Covey Family Tribute to a Highly Effective Father"),
    (31, "Foreword to the 2004 Edition by Stephen R. Covey"),
    (36, "Inside-Out"),
    (58, "The 7 Habits: An Overview"),
    (72, "Habit 1: Be Proactive"),
    (94, "Habit 2: Begin with the End in Mind"),
    (129, "Habit 3: Put First Things First"),
    (160, "Paradigms of Interdependence"),
    (174, "Habit 4: Think Win/Win"),
    (196, "Habit 5: Seek First to Understand, Then to Be Understood"),
    (215, "Habit 6: Synergize"),
    (233, "Habit 7: Sharpen the Saw"),
    (248, "Inside-Out Again"),
    (255, "Afterword"),
    (260, "Appendix A: Possible Perceptions Flowing out of Various Centers"),
    (265, "Appendix B: A Quadrant II Day at the Office"),
    (272, "A Final Interview with Stephen R. Covey"),
    (279, "About the Author"),
    (282, "Endnotes"),
]
EXCLUDED_PAGES = {20, 21, 35, 71, 159, 232, 280, 281}
MIN_IMAGE_DIMENSION = 12
FOOTNOTE_REFERENCES = {
    62: ("1", 426.4782, 130.3440),
    114: ("2", 455.9640, 115.9440),
    118: ("3", 235.2360, 116.1034),
    155: ("4", 137.6040, 445.9440),
    156: ("5", 361.4880, 202.3440),
    170: ("6", 378.1032, 622.3440),
    231: ("7", 276.1800, 622.9440),
}
FIGURE_DESCRIPTIONS = {
    43: ["A drawing of a young woman, used in the perception exercise."],
    44: ["A drawing of an older woman, used in the perception exercise."],
    57: ["The ambiguous young-woman and older-woman drawing from the perception exercise."],
    59: ["Habits shown as the intersection of knowledge, skills and desire."],
    63: ["Overview of the seven habits, from dependence through independence to interdependence."],
    71: ["Overview of the seven habits with the private victory group emphasised."],
    72: ["Overview of the seven habits with Habit 1, Be Proactive, emphasised."],
    74: ["The stimulus and response model."],
    76: ["The proactive model: freedom to choose between stimulus and response, supported by self-awareness, imagination, conscience and independent will."],
    81: ["A comparison of reactive language and proactive language."],
    83: ["A Circle of Concern surrounded by the area labelled No Concern."],
    84: ["The Circle of Influence inside the Circle of Concern."],
    85: ["Proactive focus: positive energy enlarges the Circle of Influence."],
    86: ["Reactive focus: negative energy reduces the Circle of Influence."],
    87: ["A Circle of Concern inside a larger Circle of Influence."],
    94: ["Overview of the seven habits with Habit 2, Begin with the End in Mind, emphasised."],
    104: ["Security, guidance, wisdom and power around a central point."],
    111: ["A table comparing sources of security, guidance, wisdom and power for spouse-centred and family-centred living."],
    112: ["A table comparing sources of security, guidance, wisdom and power for money, work, possessions, pleasure, friends, enemies, church and self as centres."],
    114: ["A table of security, guidance, wisdom and power for principle-centred living."],
    115: ["Principles at the centre of family, money, work, possessions, pleasure, friends, enemies, church, self and spouse."],
    127: ["A worksheet for areas of activity, character, contributions and achievements."],
    129: ["Overview of the seven habits with Habit 3, Put First Things First, emphasised."],
    133: ["The time management matrix: four quadrants formed by urgent or not urgent and important or not important."],
    134: ["Results of a focus on Quadrant I: stress, burnout, crisis management and always putting out fires."],
    135: ["Results of a focus on Quadrant III, including short-term focus, crisis management and a feeling of victimisation.", "Results of a focus on Quadrant IV: total irresponsibility, job loss and dependence on others for basics.", "Results of a focus on Quadrant II: vision, perspective, balance, discipline, control and few crises."],
    143: ["Example personal and professional roles, each connected to goals."],
    145: ["A filled weekly schedule with roles, goals, priorities and appointments, first page."],
    146: ["A filled weekly schedule with daily priorities and appointments, continuation page."],
    147: ["Long-term organising connects a mission statement, roles and goals; weekly organising adds plans, scheduling and delegation."],
    150: ["A producer model comparing input and output.", "A manager model showing larger output relative to input."],
    157: ["A blank weekly planning worksheet for roles, goals, priorities and appointments."],
    158: ["The continuation of the blank weekly planning worksheet."],
    159: ["Overview of the seven habits with the public victory group emphasised."],
    174: ["Overview of the seven habits with Habit 4, Think Win/Win, emphasised."],
    183: ["Win/Win character, relationships and agreements supported by systems and processes."],
    184: ["A courage and consideration matrix showing Lose/Win, Win/Win, Lose/Lose and Win/Lose."],
    196: ["Overview of the seven habits with Habit 5, Seek First to Understand, Then to Be Understood, emphasised."],
    215: ["Overview of the seven habits with Habit 6, Synergize, emphasised."],
    222: ["Levels of communication across trust and cooperation: defensive, respectful and synergistic."],
    228: ["Opposing restraining forces and driving forces."],
    232: ["Overview of the seven habits with Habit 7, Sharpen the Saw, emphasised."],
    234: ["The physical, mental, social or emotional, and spiritual dimensions of renewal."],
    246: ["The upward spiral of learning, committing and doing."],
    257: ["An upward spiral numbered from 1 to 7."],
    258: ["The seven habits overview with the eighth habit added."],
    261: ["Appendix A table of possible perceptions flowing from spouse, family, money, work, possessions, pleasure and friends as centres."],
    262: ["Continuation of Appendix A, showing perceptions associated with different centres."],
    263: ["Appendix A table of possible perceptions flowing from an enemy, church, self or principles as centres."],
    264: ["Continuation of the Appendix A table for an enemy, church, self or principles as centres."],
    266: ["A blank eight-to-five daily schedule."],
}


def clean_text(text: str) -> str:
    return importer.normalise_text(unicodedata.normalize("NFKC", text).replace("\u00ad", ""))


def join_lines(left: str, right: str) -> str:
    """Retain visible compound hyphens; remove only explicit soft hyphens."""
    if left.endswith("\u00ad"):
        return left[:-1] + right
    if re.search(r"\w[-‐]$", left) and re.match(r"[a-z]", right):
        return left + right
    return left + " " + right


def source_key(text: str) -> str:
    return re.sub(r"[^\w]", "", text.casefold())


def separate_footnote_reference(chars: list[dict], page: int) -> tuple[list[dict], list[dict]]:
    """Keep reviewed superscripts in provenance rather than spoken prose."""
    if page not in FOOTNOTE_REFERENCES:
        return chars, []
    value, x0, top = FOOTNOTE_REFERENCES[page]
    matches = [c for c in chars if c.get("text") == value and abs(c["x0"]-x0) < .02 and abs(c["top"]-top) < .02 and abs(c["size"]-9) < .01]
    if len(matches) != 1:
        raise importer.ImportFailure(f"Reviewed footnote reference no longer matches PDF page {page}")
    reference = matches[0]
    provenance = {"page":page,"value":value,"bbox":[round(reference[k],4) for k in ["x0","top","x1","bottom"]],"reason":"superscript reference retained here; full note remains in Endnotes, marker excluded from spoken prose"}
    return [c for c in chars if c is not reference], [provenance]


@dataclass
class TextLine:
    text: str
    page: int
    bbox: tuple[float, float, float, float]
    size: float
    bold_fraction: float
    italic_fraction: float
    kind: str = "body"


def lines_from_chars(chars: list[dict], page_number: int) -> list[TextLine]:
    """Use a common baseline so reduced-size small capitals stay in order."""
    groups: list[list[dict]] = []
    for char in sorted(chars, key=lambda c: (c["bottom"], c["x0"])):
        if not str(char.get("text", "")).strip():
            # Explicit spaces are still kept when attached to a baseline below.
            pass
        if groups and abs(char["bottom"] - max(x["bottom"] for x in groups[-1])) <= 4.0:
            groups[-1].append(char)
        else:
            groups.append([char])
    result = []
    for group in groups:
        group.sort(key=lambda c: c["x0"])
        text_parts = []
        previous = None
        for char in group:
            value = char.get("text", "")
            if previous is not None and char["x0"] - previous["x1"] > max(1.4, min(char["size"], previous["size"]) * 0.19) and text_parts and not text_parts[-1].endswith(" ") and not value.startswith(" "):
                text_parts.append(" ")
            text_parts.append(value)
            previous = char
        text = clean_text("".join(text_parts))
        if not text:
            continue
        visible = [x for x in group if str(x.get("text", "")).strip()]
        total = max(1, len(visible))
        line = TextLine(text, page_number, (min(x["x0"] for x in group), min(x["top"] for x in group), max(x["x1"] for x in group), max(x["bottom"] for x in group)), max(x["size"] for x in group), sum("Bold" in x.get("fontname", "") for x in visible)/total, sum("Italic" in x.get("fontname", "") for x in visible)/total)
        if line.size >= 18:
            line.kind = "heading"
        elif (line.size >= 14 and line.bold_fraction > .7) or (line.bold_fraction > .92 and len(text) < 300 and not re.match(r"^\d+[.)] ", text)):
            line.kind = "subheading"
        elif re.match(r"^(?:[•●▪]|\d+[.)]|[a-z][.)])\s", text):
            line.kind = "list-item"
        elif (line.size <= 10 and line.bbox[0] >= 84 and line.bbox[2] <= 542) or (line.bbox[0] >= 105 and line.bbox[2] <= 480):
            line.kind = "quote"
        result.append(line)
    return sorted(result, key=lambda line: (line.bbox[1], line.bbox[0]))


def is_new_paragraph(previous: TextLine, current: TextLine) -> bool:
    if current.kind != previous.kind:
        return True
    if current.kind in {"heading", "subheading"}:
        return current.page != previous.page or current.bbox[1] - previous.bbox[3] > 10
    if current.kind == "list-item":
        # A marker-less list line has already passed the hanging-indent and
        # font checks. A page break must not split that validated continuation.
        return bool(re.match(r"^(?:[•●▪]|\d+[.)]|[a-z][.)])\s", current.text))
    if current.page == previous.page:
        if current.bbox[1] - previous.bbox[3] > 8:
            return True
        if current.kind == "body" and 82 <= current.bbox[0] <= 101:
            return True
        if current.kind == "quote" and current.size <= 10 and 91 <= current.bbox[0] <= 104:
            return True
        if current.kind == "quote" and current.bbox[0] > 260:
            return True
        return False
    # A zero-indent line at a new page continues a running body paragraph. The
    # source's ordinary new paragraphs have an explicit first-line indent.
    if current.kind == "quote" and previous.kind == "quote" and current.size <= 10 and previous.size <= 10:
        return current.bbox[0] >= 91
    return current.kind != "body" or current.bbox[0] > 78


def continues_hanging_list(paragraph: "Paragraph", current: TextLine) -> bool:
    if paragraph.kind != "list-item" or current.kind not in {"body", "quote"}:
        return False
    first, previous = paragraph.lines[0], paragraph.lines[-1]
    if abs(current.size-first.size) > .25 or not 91 <= current.bbox[0] <= 145 or current.bbox[0] < first.bbox[0]+3:
        return False
    return current.page != previous.page or current.bbox[1]-previous.bbox[3] <= 5


@dataclass
class Paragraph:
    lines: list[TextLine] = field(default_factory=list)

    @property
    def text(self) -> str:
        text = self.lines[0].text
        for line in self.lines[1:]:
            text = join_lines(text, line.text)
        return clean_text(text)

    @property
    def kind(self) -> str:
        return self.lines[0].kind


def outline_entries(reader: PdfReader) -> list[dict]:
    result = []
    def visit(items, depth=0):
        for item in items:
            if isinstance(item, list):
                visit(item, depth+1)
            else:
                result.append({"title":item.title, "page":reader.get_destination_page_number(item)+1, "depth":depth})
    visit(reader.outline)
    return result


def check_profile(reader: PdfReader, outline: list[dict]) -> None:
    if reader.is_encrypted or len(reader.pages) != 282:
        raise importer.ImportFailure("This reviewed PDF profile requires the unencrypted 282-page edition")
    by_page = {}
    for item in outline:
        by_page.setdefault(item["page"], []).append(item["title"])
    for page, title in SECTIONS[:-2]:
        if page in {17,18}:
            expected = "TO MY COLLEAGUES" if page == 17 else "ACKNOWLEDGMENTS"
            if expected not in (reader.pages[page-1].extract_text() or ""):
                raise importer.ImportFailure("PDF dedication or acknowledgments no longer matches the reviewed edition")
            continue
        if page not in by_page:
            raise importer.ImportFailure(f"PDF outline no longer matches reviewed section on page {page}")
        if title.startswith("Habit ") and not any(f"HABIT {title[6]}:" in value.upper() for value in by_page[page]):
            raise importer.ImportFailure("PDF habit outline does not match reviewed structure")


def image_asset(image: Image.Image) -> tuple[bytes, int, int]:
    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise importer.ImportFailure("A PDF diagram exceeds the image pixel limit")
    rgb = Image.new("RGB", image.size, "white")
    if image.mode in {"RGBA", "LA"}:
        rgba = image.convert("RGBA")
        rgb.paste(rgba, mask=rgba.getchannel("A"))
    else:
        rgb.paste(image.convert("RGB"))
    out = io.BytesIO()
    rgb.save(out, "PNG", optimize=True)
    return out.getvalue(), rgb.width, rgb.height


def chapter_for_page(page: int) -> int:
    return max(i for i,(start, _) in enumerate(SECTIONS) if page >= start)


def build_contact_sheets(output: Path, figures: list[dict]) -> list[str]:
    sheets = []
    cell_w, cell_h = 330, 300
    for batch_start in range(0, len(figures), 16):
        batch = figures[batch_start:batch_start+16]
        sheet = Image.new("RGB", (cell_w*4, cell_h*math.ceil(len(batch)/4)), "#eeeeee")
        draw = ImageDraw.Draw(sheet)
        for index, figure in enumerate(batch):
            image = Image.open(output / "book-assets" / BOOK_ID / figure["filename"]).convert("RGB")
            image.thumbnail((cell_w-16, cell_h-48))
            x, y = (index%4)*cell_w, (index//4)*cell_h
            sheet.paste(image, (x+(cell_w-image.width)//2, y+8))
            label = f"PDF {figure['page']} | section {figure['chapterIndex']+1} | before {figure['beforeParagraph']}"
            draw.text((x+8,y+cell_h-34), label, fill="black")
            draw.text((x+8,y+cell_h-18), figure["filename"][:22], fill="black")
        target = output / "review" / f"diagrams-{batch_start//16+1:02d}.jpg"
        target.parent.mkdir(parents=True,exist_ok=True)
        sheet.save(target, quality=90)
        sheets.append(str(target))
    return sheets


def import_pdf(source: Path, output: Path) -> dict:
    if source.stat().st_size > MAX_SOURCE_BYTES:
        raise importer.ImportFailure("PDF exceeds the source size limit")
    source_bytes = source.read_bytes()
    if len(source_bytes) > MAX_SOURCE_BYTES or not source_bytes.startswith(b"%PDF-"):
        raise importer.ImportFailure("PDF is missing, too large or invalid")
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    reader = PdfReader(io.BytesIO(source_bytes))
    outline = outline_entries(reader)
    check_profile(reader, outline)
    edition_id = hashlib.sha256((PARSER_VERSION+":"+source_hash).encode()).hexdigest()[:16]
    canonical = {"editionId":edition_id,"chapters":[{"id":f"c{i+1}","title":title,"paragraphs":[]} for i,(_,title) in enumerate(SECTIONS)]}
    presentation = {"version":1,"bookId":BOOK_ID,"editionId":edition_id,"chapters":[{"paragraphs":{},"images":[]} for _ in SECTIONS]}
    provenance = {"parserVersion":PARSER_VERSION,"sourceSha256":source_hash,"sourceFilename":source.name,"outline":outline,"paragraphs":[],"figures":[],"omissions":[],"joins":[],"footnoteReferences":[],"textCoverage":[]}
    chapter_paragraphs: list[list[Paragraph]] = [[] for _ in SECTIONS]
    figure_events: list[dict] = []
    previous_line = None
    pending = None
    active_chapter = None
    counts = Counter()

    def flush():
        nonlocal pending
        if pending and pending.lines:
            chapter_paragraphs[active_chapter].append(pending)
        pending = None

    with pdfplumber.open(io.BytesIO(source_bytes)) as pdf:
        for page_number, page in enumerate(pdf.pages,1):
            if page_number < 17 or page_number in {20,21,280,281}:
                provenance["omissions"].append({"page":page_number,"reason":"cover, praise, publishing pages, contents or advertisements"})
                continue
            ci = chapter_for_page(page_number)
            if ci != active_chapter:
                flush()
                active_chapter = ci
                previous_line = None
            # Part divider words are redundant with the contents. Their useful
            # diagrams remain and anchor at the start of the following section.
            chars = [] if page_number in EXCLUDED_PAGES else page.chars
            chars, references = separate_footnote_reference(chars,page_number)
            provenance["footnoteReferences"].extend(references)
            images = sorted(page.images,key=lambda x:(x["top"],x["x0"]))
            lines = lines_from_chars(chars,page_number)
            expected_glyphs = Counter(re.sub(r"\s", "",clean_text("".join(c.get("text", "") for c in chars))))
            actual_glyphs = Counter(re.sub(r"\s", "","".join(line.text for line in lines)))
            if expected_glyphs != actual_glyphs:
                raise importer.ImportFailure(f"Extracted text loses or adds source glyphs on PDF page {page_number}")
            provenance["textCoverage"].append({"page":page_number,"sourceNonWhitespaceCharacters":sum(expected_glyphs.values()),"extractedNonWhitespaceCharacters":sum(actual_glyphs.values()),"exactCharacterMultiset":True})
            image_objects = {image.name.rsplit(".",1)[0]:image for image in reader.pages[page_number-1].images} if images else {}
            events = [(line.bbox[1],"line",line) for line in lines]
            for ordinal, image in enumerate(images):
                if image["x1"]-image["x0"] < MIN_IMAGE_DIMENSION or image["bottom"]-image["top"] < MIN_IMAGE_DIMENSION:
                    provenance["omissions"].append({"page":page_number,"reason":"decorative image strip","bbox":[image[k] for k in ["x0","top","x1","bottom"]]})
                    continue
                events.append((image["top"],"image",(ordinal,image)))
            for _,event_type,event in sorted(events,key=lambda x:x[0]):
                if event_type == "image":
                    flush()
                    previous_line = None
                    ordinal, image = event
                    image_object = image_objects.get(image["name"])
                    if image_object is None:
                        raise importer.ImportFailure(f"Cannot resolve diagram object on page {page_number}")
                    asset, width, height = image_asset(image_object.image)
                    asset_id = hashlib.sha256(asset).hexdigest()
                    filename = f"{asset_id}.png"
                    target = output / "book-assets" / BOOK_ID / filename
                    target.parent.mkdir(parents=True,exist_ok=True)
                    target.write_bytes(asset)
                    # Divider figures belong to the next actual reading section.
                    image_ci = ci+1 if page_number in {71,159,232} else ci
                    boundary = 0 if image_ci != ci else len(chapter_paragraphs[ci])
                    descriptions = FIGURE_DESCRIPTIONS.get(page_number,[])
                    if ordinal >= len(descriptions):
                        raise importer.ImportFailure(f"A diagram on PDF page {page_number} has not been reviewed")
                    descriptor = {"id":asset_id,"filename":filename,"mediaType":"image/png","beforeParagraph":boundary,"width":width,"height":height,"alt":descriptions[ordinal]}
                    presentation["chapters"][image_ci]["images"].append(descriptor)
                    figure_events.append({**descriptor,"page":page_number,"imageObject":image["name"],"chapterIndex":image_ci,"bbox":[round(image[k],4) for k in ["x0","top","x1","bottom"]],"sourcePixelDimensions":list(image["srcsize"]),"sourceOrdinal":ordinal})
                    continue
                line = event
                # Ignore only actual isolated separators and annotation markers.
                if re.fullmatch(r"\*{2,}|[•·]{1,3}",line.text):
                    flush(); previous_line = None
                    provenance["omissions"].append({"page":page_number,"reason":"decorative section separator","bbox":line.bbox,"text":line.text})
                    continue
                if pending is not None and continues_hanging_list(pending,line):
                    line.kind = "list-item"
                if pending is None or previous_line is None or is_new_paragraph(previous_line,line):
                    flush()
                    pending = Paragraph([line])
                else:
                    pending.lines.append(line)
                    if previous_line.page != line.page:
                        provenance["joins"].append({"fromPage":previous_line.page,"toPage":line.page,"reason":"unindented body continuation across page break"})
                previous_line = line
            page.flush_cache()
            if page_number % 30 == 0:
                print(f"Read PDF page {page_number}/282",flush=True)
    flush()
    for ci, paragraphs in enumerate(chapter_paragraphs):
        # Keep chapter heading text as canonical paragraphs but hide duplicates
        # of the displayed chapter title. This retains auditable source ranges.
        for pi, paragraph in enumerate(paragraphs):
            text = paragraph.text
            if "\ufffd" in text or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]",text):
                raise importer.ImportFailure("A PDF paragraph contains an invalid text glyph")
            canonical["chapters"][ci]["paragraphs"].append(text)
            kind = paragraph.kind
            settings = {"kind":kind} if kind != "body" else {}
            if kind == "heading" and pi < 3:
                line_key = source_key(text)
                title_key = source_key(SECTIONS[ci][1])
                if line_key in title_key or title_key in line_key:
                    settings["hidden"] = True
            if settings:
                presentation["chapters"][ci]["paragraphs"][str(pi)] = settings
            provenance["paragraphs"].append({"chapterIndex":ci,"paragraphIndex":pi,"kind":kind,"lines":[{"page":line.page,"bbox":[round(n,4) for n in line.bbox],"fontSize":round(line.size,3),"text":line.text} for line in paragraph.lines]})
            counts[kind] += 1
        if not paragraphs:
            raise importer.ImportFailure(f"No text remains for section {ci+1}")
    provenance["figures"] = figure_events
    for ci, chapter in enumerate(presentation["chapters"]):
        for image in chapter["images"]:
            if not 0 <= image["beforeParagraph"] <= len(canonical["chapters"][ci]["paragraphs"]):
                raise importer.ImportFailure("Diagram anchor lies outside its chapter")
            asset_path = output / "book-assets" / BOOK_ID / image["filename"]
            if hashlib.sha256(asset_path.read_bytes()).hexdigest() != image["id"]:
                raise importer.ImportFailure("Diagram hash mismatch")
            with Image.open(asset_path) as asset:
                if asset.size != (image["width"],image["height"]):
                    raise importer.ImportFailure("Diagram dimensions mismatch")
    word_count = sum(len(importer.WORD_RE.findall(text)) for chapter in canonical["chapters"] for text in chapter["paragraphs"])
    summary = {"bookId":BOOK_ID,"title":TITLE,"sourceFormat":"PDF","sourceSha256":source_hash,"parserVersion":PARSER_VERSION,"editionId":edition_id,"isComplete":True,"pageCount":len(reader.pages),"wordCount":word_count,"readingMinutes":math.ceil(word_count/250),"chapterCount":len(SECTIONS),"paragraphCount":sum(len(c["paragraphs"]) for c in canonical["chapters"]),"imageOccurrences":len(figure_events),"imageAssets":len({x["id"] for x in figure_events}),"paragraphKinds":dict(counts),"omittedImageCount":0,"chapters":[{"title":c["title"],"paragraphs":len(c["paragraphs"]),"images":len(presentation["chapters"][i]["images"]),"startPage":SECTIONS[i][0]} for i,c in enumerate(canonical["chapters"])]}
    importer.write_json(output / "books" / f"{BOOK_ID}.json",canonical)
    importer.write_json(output / "reader" / f"{BOOK_ID}.json",presentation)
    importer.write_json(output / "review" / "provenance.json",provenance)
    summary["contactSheets"] = build_contact_sheets(output,figure_events)
    importer.write_json(output / "import-summary.json",summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path,required=True)
    parser.add_argument("--output",type=Path,default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    permitted = (importer.PROJECT_ROOT / ".local/pdf-import").resolve()
    if not output.is_relative_to(permitted) or output == permitted:
        parser.error("Output must be a book-specific staging directory inside .local/pdf-import")
    try:
        summary = import_pdf(args.source,output)
    except (importer.ImportFailure,OSError,ValueError) as error:
        parser.exit(1,f"PDF import stopped: {error}\n")
    print(json.dumps({k:v for k,v in summary.items() if k not in {"chapters","contactSheets"}},indent=2))


if __name__ == "__main__":
    main()
