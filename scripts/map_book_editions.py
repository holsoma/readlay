"""Map verified word locations between editions without changing either source.

Only identifiers and numeric positions enter the generated migration manifest.
Unmatched passages remain absent rather than receiving guessed locations.
"""
from __future__ import annotations

import argparse
from bisect import bisect_left
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re
import unicodedata

WORD = re.compile(r"(?:\d+(?:[,.]\d+)+|[^\W_]+(?:['’\-‐‑][^\W_]+)*)", re.UNICODE)


def normalise(value: str) -> str:
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", value).casefold())


@dataclass(frozen=True)
class Token:
    value: str
    chapter: int
    paragraph: int
    start: int
    end: int


def flatten(book: dict) -> tuple[list[Token], dict[tuple[int, int], list[int]]]:
    tokens, paragraphs = [], {}
    for ci, chapter in enumerate(book["chapters"]):
        for pi, text in enumerate(chapter["paragraphs"]):
            if not isinstance(text, str):
                raise ValueError("Canonical paragraphs must be strings.")
            offsets, current = [0], 0
            for character in text:
                current += 2 if ord(character) > 0xFFFF else 1
                offsets.append(current)
            indices = []
            for match in WORD.finditer(text):
                indices.append(len(tokens))
                tokens.append(Token(normalise(match.group()), ci, pi, offsets[match.start()], offsets[match.end()]))
            paragraphs[ci, pi] = indices
    return tokens, paragraphs


def unique_seed_chain(a: list[str], b: list[str], width: int = 8) -> list[tuple[int, int]]:
    old = [tuple(a[i:i + width]) for i in range(max(0, len(a) - width + 1))]
    new = [tuple(b[i:i + width]) for i in range(max(0, len(b) - width + 1))]
    old_counts, new_counts = Counter(old), Counter(new)
    destinations = {key: index for index, key in enumerate(new) if new_counts[key] == 1}
    candidates = [(index, destinations[key]) for index, key in enumerate(old)
                  if old_counts[key] == 1 and key in destinations]
    tails, tail_indices, previous = [], [], []
    for index, (_, destination) in enumerate(candidates):
        slot = bisect_left(tails, destination)
        previous.append(tail_indices[slot - 1] if slot else -1)
        if slot == len(tails):
            tails.append(destination)
            tail_indices.append(index)
        else:
            tails[slot], tail_indices[slot] = destination, index
    chain, cursor = [], tail_indices[-1] if tail_indices else -1
    while cursor >= 0:
        chain.append(candidates[cursor])
        cursor = previous[cursor]
    return list(reversed(chain))


def verified_pairs(a: list[str], b: list[str]) -> dict[int, int]:
    if max(len(a), len(b)) < 4000:
        pairs = {}
        for block in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
            if block.size < 3:
                continue
            phrase = a[block.a:block.a + block.size]
            if sum(a[i:i + block.size] == phrase for i in range(len(a) - block.size + 1)) != 1 or \
                    sum(b[i:i + block.size] == phrase for i in range(len(b) - block.size + 1)) != 1:
                continue
            pairs.update((block.a + k, block.b + k) for k in range(block.size))
        return pairs
    seeds = unique_seed_chain(a, b)
    pairs: dict[int, int] = {}
    previous_a, previous_b = -8, -8
    for ai, bi in seeds:
        # Keep disjoint, monotonic unique anchors. Extending an anchor across
        # another candidate can otherwise capture a repeated adjacent phrase.
        if ai < previous_a + 8 or bi < previous_b + 8:
            continue
        pairs.update((ai + k, bi + k) for k in range(8))
        previous_a, previous_b = ai, bi
    ordered = sorted(pairs.items())
    # Exact anchors bound small editorial differences. Work only within these
    # bounded gaps, avoiding unconstrained fuzzy matches over an entire book.
    boundaries = [(-1, -1), *ordered, (len(a), len(b))]
    additions = {}
    for (old_left, new_left), (old_right, new_right) in zip(boundaries, boundaries[1:]):
        old_count, new_count = old_right - old_left - 1, new_right - new_left - 1
        if not (0 < old_count <= 1200 and 0 < new_count <= 4000):
            continue
        aa, bb = a[old_left + 1:old_right], b[new_left + 1:new_right]
        if aa == bb and old_left >= 0 and old_right < len(a):
            additions.update((old_left + 1 + k, new_left + 1 + k) for k in range(len(aa)))
            continue
        for block in SequenceMatcher(None, aa, bb, autojunk=False).get_matching_blocks():
            if block.size < 3:
                continue
            for k in range(block.size):
                additions[old_left + 1 + block.a + k] = new_left + 1 + block.b + k
    pairs.update(additions)
    ordered = sorted(pairs.items())
    if any(right[1] <= left[1] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("Edition alignment contains competing or reordered passages; manual review is required.")
    return pairs


def map_editions(old: dict, new: dict, book_id: str) -> tuple[dict, dict]:
    if old["editionId"] == new["editionId"]:
        raise ValueError("Source and replacement must have different edition identifiers.")
    for edition in (old["editionId"], new["editionId"]):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", edition):
            raise ValueError("Invalid edition identifier.")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", book_id):
        raise ValueError("Invalid book identifier.")
    source, paragraphs = flatten(old)
    target, _ = flatten(new)
    pairs = verified_pairs([word.value for word in source], [word.value for word in target])
    mapping, missing, partial = {}, [], []
    for (ci, pi), indices in paragraphs.items():
        mapped = [index for index in indices if index in pairs]
        if not mapped or len(mapped) < min(3, len(indices)) or len(mapped) < len(indices) * 0.45:
            missing.append({"chapterIndex": ci, "paragraphIndex": pi, "words": len(indices), "matchedWords": len(mapped)})
            continue
        anchor = target[pairs[mapped[0]]]
        words = []
        for index in mapped:
            before, after = source[index], target[pairs[index]]
            if before.value != after.value:
                raise ValueError("A proposed migration changes a word's lexical value.")
            words.append([before.start, before.end, after.chapter, after.paragraph, after.start, after.end])
        text = old["chapters"][ci]["paragraphs"][pi]
        mapping[f"{ci}:{pi}"] = {"sourceLength": len(text.encode("utf-16-le")) // 2,
                                "target": {"chapterIndex": anchor.chapter, "paragraphIndex": anchor.paragraph, "charOffset": anchor.start},
                                "words": words}
        if len(mapped) != len(indices):
            partial.append({"chapterIndex": ci, "paragraphIndex": pi, "words": len(indices), "matchedWords": len(mapped)})
    manifest = {"schemaVersion": 1, "bookId": book_id, "fromEditionId": old["editionId"],
                "toEditionId": new["editionId"], "paragraphs": mapping}
    report = {"bookId": book_id, "fromEditionId": old["editionId"], "toEditionId": new["editionId"],
              "sourceWords": len(source), "targetWords": len(target), "verifiedWordMatches": len(pairs),
              "mappedWords": sum(len(item["words"]) for item in mapping.values()), "sourceParagraphs": len(paragraphs),
              "mappedParagraphs": len(mapping), "unmappedParagraphs": missing, "partialParagraphs": partial}
    return manifest, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-book", required=True, type=Path)
    parser.add_argument("--new-book", required=True, type=Path)
    parser.add_argument("--book-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    old_bytes, new_bytes = args.old_book.read_bytes(), args.new_book.read_bytes()
    manifest, report = map_editions(json.loads(old_bytes), json.loads(new_bytes), args.book_id)
    report.update(sourceSha256=hashlib.sha256(old_bytes).hexdigest(), targetSha256=hashlib.sha256(new_bytes).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("mappedParagraphs", "sourceParagraphs", "mappedWords", "sourceWords")}))


if __name__ == "__main__":
    main()
