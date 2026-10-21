"""Offline acoustic CTC forced alignment, with no estimated timing fallback."""

from __future__ import annotations

import importlib.metadata
import math
import os
import re
import unicodedata
import wave
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .core import PreparationError, SAMPLE_RATE, file_digest
from .locations import source_words

MODEL_ID = "facebook/wav2vec2-base-960h"
MODEL_REVISION = "22aad52d435eb6dbaf354bdad9b0da84ce7d6156"
ALIGNMENT_VERSION = "readlay-ctc-viterbi-v3"
NORMALISATION_VERSION = "readlay-spoken-english-v5"
MINIMUM_MEAN_CONFIDENCE = 0.20
MINIMUM_WORD_CONFIDENCE = 0.08
EXPECTED_MODEL_SHA256 = "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a"
MODEL_ASSETS = ("config.json", "preprocessor_config.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "model.safetensors")

VULGAR_FRACTIONS = {"¼": "one quarter", "½": "one half", "¾": "three quarters", "⅐": "one seventh", "⅑": "one ninth", "⅒": "one tenth",
                   "⅓": "one third", "⅔": "two thirds", "⅕": "one fifth", "⅖": "two fifths", "⅗": "three fifths", "⅘": "four fifths",
                   "⅙": "one sixth", "⅚": "five sixths", "⅛": "one eighth", "⅜": "three eighths", "⅝": "five eighths", "⅞": "seven eighths"}
DIGIT_NAMES = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine")
# Literal model, event and article IDs checked against their source editions.
# This allowlist does not turn unknown mixed tokens or OCR damage into guesses.
LITERAL_IDENTIFIER_LABELS = frozenset(("A380", "NY2011", "eaao5961"))
IDENTIFIER_PATTERN = re.compile(r"\b(?:https?://|www\.)[^\s<>\"“”]+|\b(?:doi\s*:\s*)?10\.\d{4,9}/[^\s<>\"“”]+"
                                r"|(?<!\w)@[A-Za-z0-9_]+|\b[A-Za-z]+\.\d+(?:\.\d+){2,}"
                                r"|\b[A-Za-z][A-Za-z0-9_-]*/(?:[A-Za-z0-9_-]+/)+[A-Za-z0-9_/-]+", re.IGNORECASE)


class AcousticAlignmentError(PreparationError):
    """Speech could not be measured safely, rather than unsupported source text."""


def identifier_spans(text: str) -> list[tuple[int, int]]:
    """Explicit URLs and DOIs, never a guessed mixed alphanumeric word."""
    return [(match.start(), match.start() + len(match.group().rstrip(".,;:!?)]}'’"))) for match in IDENTIFIER_PATTERN.finditer(text)]


def identifier_word(text: str) -> str:
    """Read an identifier literally, keeping all its original source characters.

    Numeric groups in identifiers are digits, not amounts or decimal numbers.
    Ordinary alphabetic URL words keep their existing transcript. Mixed path
    tokens spell letters so a random identifier is never guessed as English.
    """
    if text.lower() in ("http", "https"):
        return " ".join(text.upper())
    if not any(character.isdecimal() for character in text):
        return spoken_word(text)
    result = []
    for segment in re.split(r"([.,\-‐‑'’])", text):
        if not segment:
            continue
        if segment in ".,-‐‑'’":
            result.append({".": "dot", ",": "comma", "'": "apostrophe", "’": "apostrophe"}.get(segment, "dash"))
        elif segment.isascii() and segment.isalpha():
            # A readable URL slug keeps its words. A year in one component
            # must not turn every other component into individual letters.
            result.append(spoken_word(segment))
        else:
            for character in segment:
                if character.isascii() and character.isdecimal():
                    result.append(DIGIT_NAMES[int(character)])
                elif character.isascii() and character.isalpha():
                    result.append(character.upper())
                else:
                    raise PreparationError("An identifier contains a character that needs an explicit written pronunciation before narration.")
    return " ".join(result)


def spoken_word(text: str, currency: str | None = None) -> str:
    """The exact transcript passed to both Kokoro and the acoustic aligner."""
    try:
        from num2words import num2words
    except ImportError as error:
        raise PreparationError("Install requirements-audio.txt in the separate audio environment before narration.") from error
    if text in VULGAR_FRACTIONS:
        if currency:
            raise PreparationError("A currency expression needs explicit source review.")
        return VULGAR_FRACTIONS[text]
    mixed_fraction = re.fullmatch(r"(\d+)([" + "".join(VULGAR_FRACTIONS) + r"])", text)
    if mixed_fraction:
        if currency:
            raise PreparationError("A currency expression needs explicit source review.")
        return spoken_word(mixed_fraction.group(1)) + " and " + VULGAR_FRACTIONS[mixed_fraction.group(2)]
    if any(unicodedata.category(character).startswith("N") and not character.isdecimal() for character in text):
        raise PreparationError("A fraction, superscript or non-decimal number needs an explicit written pronunciation before narration.")
    translated = text.translate(str.maketrans({"’": "'", "‐": "-", "‑": "-", "ß": "ss", "œ": "oe", "Œ": "Oe", "æ": "ae", "Æ": "Ae", "ø": "o", "Ø": "O"}))
    if "-" in translated and any(character.isdecimal() for character in translated):
        if currency:
            raise PreparationError("A currency expression needs explicit source review.")
        parts = translated.split("-")
        if len(parts) == 2 and all(part.isdecimal() for part in parts):
            return " to ".join(spoken_word(part) for part in parts)
        return " ".join(spoken_word(part) for part in parts)
    plain = unicodedata.normalize("NFKD", translated).encode("ascii", "ignore").decode()
    decade = re.fullmatch(r"(\d{2}|\d{3}|\d{4})'?s", plain, re.IGNORECASE)
    ordinal = re.fullmatch(r"(\d+)(st|nd|rd|th)", plain, re.IGNORECASE)
    numeric = re.fullmatch(r"\d+(?:[,.]\d+)*", plain)
    if decade:
        number = int(decade.group(1))
        if number % 10 or number < 10:
            raise PreparationError("A decade token needs an explicit written pronunciation before narration.")
        if number >= 100 and number % 100 == 0:
            plain = num2words(number // 100, lang="en") + " hundreds"
        elif len(decade.group(1)) == 3:
            raise PreparationError("A decade token needs an explicit written pronunciation before narration.")
        else:
            prefix, suffix_number = (num2words(number // 100) + " ", number % 100) if number >= 1000 and number % 100 else ("", number)
            value = num2words(suffix_number, lang="en")
            plural = value[:-1] + "ies" if value.endswith("y") else value + "s"
            plain = prefix + plural
    elif ordinal:
        number = int(ordinal.group(1))
        suffix = "th" if 10 <= number % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
        if ordinal.group(2).lower() != suffix:
            raise PreparationError("A numeric ordinal has an invalid suffix. Correct the source before narration.")
        plain = num2words(number, to="ordinal", lang="en")
    elif numeric:
        if "," in plain and not re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", plain):
            raise PreparationError("An ambiguous numeric format needs source review before narration.")
        clean = plain.replace(",", "")
        try:
            number = Decimal(clean)
        except InvalidOperation as error:
            raise PreparationError("A number cannot be normalised without changing its meaning.") from error
        if currency:
            if number.as_tuple().exponent < -2:
                raise PreparationError("A currency amount has more than two decimal places. Review the source before narration.")
            plain = num2words(number, to="currency", currency=currency, lang="en")
        else:
            plain = num2words(number if "." in clean else int(number), lang="en")
    elif any(character.isdigit() for character in plain):
        prefix_label = re.fullmatch(r"([FQ])(\d)", plain, re.IGNORECASE)
        suffix_label = re.fullmatch(r"(\d+)(K|AC|WW|MP|ff|n)", plain, re.IGNORECASE)
        multiplier = re.fullmatch(r"(\d+)x", plain, re.IGNORECASE)
        leading_multiplier = re.fullmatch(r"x(\d+)", plain, re.IGNORECASE)
        repeated_multiplier = re.fullmatch(r"(\d+)x(\d+)x", plain, re.IGNORECASE)
        if currency:
            raise PreparationError("A currency expression needs explicit source review.")
        if prefix_label and (prefix_label.group(1).upper() == "F" and prefix_label.group(2) == "1" or prefix_label.group(1).upper() == "Q" and prefix_label.group(2) in "1234"):
            plain = prefix_label.group(1).upper() + " " + num2words(int(prefix_label.group(2)), lang="en")
        elif suffix_label:
            plain = num2words(int(suffix_label.group(1)), lang="en") + " " + " ".join(suffix_label.group(2).upper())
        elif multiplier:
            plain = num2words(int(multiplier.group(1)), lang="en") + " times"
        elif leading_multiplier:
            plain = "times " + num2words(int(leading_multiplier.group(1)), lang="en")
        elif repeated_multiplier:
            plain = num2words(int(repeated_multiplier.group(1)), lang="en") + " times " + num2words(int(repeated_multiplier.group(2)), lang="en") + " times"
        elif plain in LITERAL_IDENTIFIER_LABELS:
            plain = identifier_word(plain)
        else:
            raise PreparationError("A mixed letter/number token needs an explicit pronunciation before narration.")
    plain = re.sub(r"[-]", " ", plain)
    plain = re.sub(r"[^A-Za-z' ]", "", plain)
    plain = re.sub(r"\s+", " ", plain).strip().strip("'")
    if not plain or not any(character.isalpha() for character in plain):
        raise PreparationError("A source word cannot be represented by the English alignment model. Correct or explicitly transliterate that source before preparing audio.")
    return plain


def spoken_sentence(text: str) -> tuple[str, list[dict]]:
    identifiers = identifier_spans(text)
    in_identifier = lambda position: any(start <= position < end for start, end in identifiers)
    # The supplied EPUB has flattened superscripts in these formulae. Reading
    # the surviving long decimal as an ordinary number would change the lesson.
    # Require a reviewed source overlay instead of trying to reconstruct powers.
    for expression in re.finditer(r"\d+\.\d{3,}\s*=\s*\d+(?:\.\d+)?", text):
        if not in_identifier(expression.start()):
            raise PreparationError("An ambiguous decimal formula needs an explicit written pronunciation before narration.")
    operand = r"(?:\d+(?:[,.]\d+)*|[A-Za-z])"
    for match in re.finditer(r"[<>^×÷√±∑∫]", text):
        if in_identifier(match.start()):
            continue
        symbol = match.group()
        left = re.search(r"(?<![\w.])" + operand + r"\s*$", text[:match.start()])
        right = re.match(r"\s*[-−]?\s*" + operand + r"(?!\w|\.\d)", text[match.end():])
        uppercase_formula = symbol in "×÷<>±" and re.search(r"\b[A-Z]{2,}\s*$", text[:match.start()]) and re.match(r"\s*[A-Z]{2,}\b", text[match.end():])
        prose_arrow = symbol == ">" and match.start() > 0 and text[match.start() - 1].isspace() and re.search(r"[A-Za-z)]\s+$", text[:match.start()]) and re.match(r"\s+[A-Za-z]", text[match.end():])
        if symbol in "∑∫" or not (uppercase_formula or prose_arrow) and (not right or (symbol not in "√±" and not left) or symbol == "^" and not re.match(r"\s*\d", text[match.end():])):
            raise PreparationError("Mathematical notation needs an explicit written pronunciation before narration.")
    words = source_words(text)
    parts, mapped, cursor = [], [], 0
    for index, word in enumerate(words):
        separator = text[cursor:word["start"]]
        identifier = in_identifier(word["start"])
        leading_decimal = not identifier and word["text"][0].isdecimal() and re.search(r"(?<!\d)\.$", separator)
        if leading_decimal:
            if not word["text"].isdecimal():
                raise PreparationError("A leading decimal needs an explicit written pronunciation before narration.")
            separator = separator[:-1]
        previous_word = words[index - 1] if index else None
        if not identifier and previous_word and previous_word["text"][0].isdecimal() and word["text"][0].isdecimal():
            separator = re.sub(r"[–\u2014]\s*(?=[-−]?\s*$)", " to ", separator)
            if re.fullmatch(r"\s*[/⁄]\s*", separator):
                if word["text"].replace(",", "").isdecimal() and int(word["text"].replace(",", "")) == 0:
                    raise PreparationError("A fraction has a zero denominator. Review the source before narration.")
                chained = re.search(r"\d\s*[/⁄]\s*\d[^A-Za-z]*[/⁄]\s*\d", text)
                separator = " slash " if chained else " over "
        # Dictionary syllable markers split lexical source ranges but must not
        # turn a single spoken word into separate narrated fragments.
        if separator and all(character in "·‧" for character in separator):
            separator = ""
        negative_match = re.search(r"[-−]\s*$", separator) if not identifier and word["text"][0].isdecimal() else None
        negative = negative_match is not None
        if negative_match:
            separator = separator[:negative_match.start()]
        currency_match = re.search(r"([$£€])\s*$", separator) if not identifier else None
        currency = {"$": "USD", "£": "GBP", "€": "EUR"}.get(currency_match.group(1)) if currency_match else None
        if currency_match:
            separator = separator[:currency_match.start()]
        if not identifier and not negative and word["text"][0].isdecimal():
            negative_match = re.search(r"[-−]\s*$", separator)
            if negative_match:
                negative = True
                separator = separator[:negative_match.start()]
        # Symbols with speech semantics become explicit transcript words. They
        # are acoustic alignment tokens but have no invented source word range.
        if identifier:
            separator = separator.translate(str.maketrans({".": " dot ", ":": " colon ", "/": " slash ", "⁄": " slash ", "?": " question mark ", "=": " equals ", "#": " hash ", "_": " underscore ", "~": " tilde ", "-": " dash ", "^": " caret "}))
        elif ">" in separator and previous_word and len(previous_word["text"]) > 1 and len(word["text"]) > 1 and not (previous_word["text"].isupper() and word["text"].isupper()) and not previous_word["text"][0].isdecimal() and not word["text"][0].isdecimal() and re.search(r"\s>\s", separator):
            separator = separator.replace(">", " then ")
        separator = separator.translate(str.maketrans({"&": " and ", "%": " percent ", "+": " plus ", "@": " at ", "$": " dollar ", "£": " pound ", "€": " euro ", "=": " equals ", "<": " less than ", ">": " greater than ", "^": " to the power of ", "×": " times ", "÷": " divided by ", "√": " square root of ", "±": " plus or minus ", "−": " minus "}))
        separator = "".join(character if character in ".,!?;:()\"' \n\t" or character.isascii() and character.isalpha() else " " for character in separator)
        parts.append(separator)
        start = sum(len(part) for part in parts)
        normalised = identifier_word(word["text"]) if identifier else spoken_word(word["text"], currency)
        if leading_decimal:
            normalised = spoken_word("0." + word["text"], currency) if currency else "zero point " + " ".join(DIGIT_NAMES[int(character)] for character in word["text"])
        if negative:
            normalised = "minus " + normalised
        parts.append(normalised)
        mapped.append({**word, "spokenStart": start, "spokenEnd": start + len(normalised)})
        cursor = word["end"]
    suffix = text[cursor:]
    suffix = suffix.translate(str.maketrans({"%": " percent ", "&": " and ", "+": " plus ", "@": " at ", "=": " equals ", "−": " minus "}))
    parts.append("".join(character if character in ".,!?;:()\"' \n\t" or character.isascii() and character.isalpha() else " " for character in suffix))
    return "".join(parts), mapped


def ctc_viterbi(log_probs, targets: list[int], blank: int) -> list[tuple[int, int, float]]:
    """Maximum-likelihood monotonic CTC path, retaining every target label.

    Each target has its own state, separated by explicit blank states. A skip
    across a blank is permitted only when adjacent labels differ. This handles
    repeated letters and does not infer positions from character counts.
    """
    import numpy as np
    probabilities = np.asarray(log_probs, dtype=np.float32)
    if probabilities.ndim != 2 or not len(targets) or not np.isfinite(probabilities).all():
        raise AcousticAlignmentError("The acoustic aligner returned invalid emissions or an empty transcript.")
    frames, _ = probabilities.shape
    labels = np.full(2 * len(targets) + 1, blank, dtype=np.int64)
    labels[1::2] = targets
    states = len(labels)
    if frames < len(targets) + sum(left == right for left, right in zip(targets, targets[1:])):
        raise AcousticAlignmentError("The audio is too short for every transcript label. No approximate alignment was produced.")
    previous = np.full(states, -np.inf, dtype=np.float32)
    previous[0] = probabilities[0, blank]
    previous[1] = probabilities[0, targets[0]]
    backtrack = np.zeros((frames, states), dtype=np.uint8)
    skip_allowed = (np.arange(states) >= 2) & (labels != blank) & (labels != np.roll(labels, 2))
    for frame in range(1, frames):
        stay = previous
        step = np.concatenate(([-np.inf], previous[:-1]))
        skip = np.concatenate(([-np.inf, -np.inf], previous[:-2]))
        skip[~skip_allowed] = -np.inf
        choices = np.stack((stay, step, skip))
        direction = choices.argmax(axis=0)
        previous = choices[direction, np.arange(states)] + probabilities[frame, labels]
        backtrack[frame] = direction
    state = states - 1 if previous[-1] >= previous[-2] else states - 2
    if not math.isfinite(float(previous[state])):
        raise AcousticAlignmentError("No complete acoustic alignment path exists for the supplied transcript.")
    assigned: list[list[int]] = [[] for _ in targets]
    for frame in range(frames - 1, -1, -1):
        if state % 2:
            assigned[state // 2].append(frame)
        if frame:
            state -= int(backtrack[frame, state])
    result = []
    for token, positions in zip(targets, assigned):
        if not positions:
            raise AcousticAlignmentError("The forced alignment omitted a transcript label.")
        start, end = min(positions), max(positions) + 1
        confidence = float(np.exp(probabilities[positions, token]).mean())
        result.append((start, end, confidence))
    return result


class Wav2Vec2Aligner:
    def __init__(self, allow_download: bool = False, device: str = "cpu"):
        if not allow_download:
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parents[2] / ".local" / "audio-models"))
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        try:
            import numpy as np
            import torch
            from huggingface_hub import snapshot_download
            from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
            directory = Path(snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_files_only=not allow_download,
                                               allow_patterns=list(MODEL_ASSETS)))
            if file_digest(directory / "model.safetensors") != EXPECTED_MODEL_SHA256:
                raise PreparationError("The cached pinned acoustic model hash does not match its official asset.")
            self.processor = Wav2Vec2Processor.from_pretrained(str(directory), local_files_only=True)
            self.model = Wav2Vec2ForCTC.from_pretrained(str(directory), local_files_only=True, use_safetensors=True).to(device).eval()
        except Exception as error:
            raise PreparationError("The pinned local forced-alignment model could not load. Install requirements-audio.txt, then run once with --allow-download. No estimated word timings were produced.") from error
        self.np, self.torch, self.device = np, torch, device
        self.vocab = self.processor.tokenizer.get_vocab()
        self.blank = self.processor.tokenizer.pad_token_id
        self.fingerprint = {"engine": "wav2vec2-ctc-viterbi", "algorithm": ALIGNMENT_VERSION,
                            "model": MODEL_ID, "revision": MODEL_REVISION, "license": "Apache-2.0",
                            "assets": {name: file_digest(directory / name) for name in MODEL_ASSETS},
                            "transformersVersion": importlib.metadata.version("transformers"), "torchVersion": torch.__version__,
                            "numpyVersion": np.__version__, "normalisation": NORMALISATION_VERSION,
                            "scipyVersion": importlib.metadata.version("scipy"),
                            "num2wordsVersion": importlib.metadata.version("num2words"), "device": device,
                            "minimumMeanConfidence": MINIMUM_MEAN_CONFIDENCE, "minimumWordConfidence": MINIMUM_WORD_CONFIDENCE,
                            "minimumRms": 0.001, "minimumPeak": 0.005}
        self.fingerprint["frameStrideSamples"] = math.prod(self.model.config.conv_stride)
        self.fingerprint["acousticSampleRate"] = 16000
        print("Pinned English CTC forced-alignment model is ready.", flush=True)

    def align(self, wav_path: Path, spoken: str, mapped: list[dict]) -> list[dict]:
        with wave.open(str(wav_path), "rb") as handle:
            if (handle.getframerate(), handle.getnchannels(), handle.getsampwidth()) != (SAMPLE_RATE, 1, 2):
                raise PreparationError("The aligner requires mono 24 kHz PCM sentence audio.")
            pcm = self.np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(self.np.float32) / 32768
        if not len(pcm) or float(self.np.sqrt(self.np.mean(pcm * pcm))) < self.fingerprint["minimumRms"] or float(self.np.max(self.np.abs(pcm))) < self.fingerprint["minimumPeak"]:
            raise AcousticAlignmentError("The sentence waveform contains no usable speech signal. It was not aligned.")
        # Band-limited resampling avoids aliasing the model's 16 kHz input.
        from scipy.signal import resample_poly
        samples = resample_poly(pcm, 2, 3).astype(self.np.float32)
        values = self.processor(samples, sampling_rate=16000, return_tensors="pt").input_values.to(self.device)
        with self.torch.inference_mode():
            emissions = self.model(values).logits[0].log_softmax(-1).cpu().numpy()
        characters, owners = [], []
        for match in re.finditer(r"[A-Za-z]+(?:'[A-Za-z]+)*", spoken):
            if characters:
                characters.append("|")
                owners.append(None)
            for character_index, character in enumerate(match.group().upper()):
                spoken_offset = match.start() + character_index
                owner = next((index for index, word in enumerate(mapped) if word["spokenStart"] <= spoken_offset < word["spokenEnd"]), None)
                if character not in self.vocab:
                    raise PreparationError("An alignment transcript character is unsupported by the pinned vocabulary.")
                characters.append(character)
                owners.append(owner)
        targets = [self.vocab[character] for character in characters]
        spans = ctc_viterbi(emissions, targets, self.blank)
        scale = self.fingerprint["frameStrideSamples"] / self.fingerprint["acousticSampleRate"]
        words = []
        for index, word in enumerate(mapped):
            pieces = [span for span, owner in zip(spans, owners) if owner == index]
            if not pieces:
                raise AcousticAlignmentError("A source word has no acoustic alignment labels.")
            confidence = sum(piece[2] for piece in pieces) / len(pieces)
            start, end = pieces[0][0] * scale, min(len(pcm) / SAMPLE_RATE, pieces[-1][1] * scale)
            if confidence < self.fingerprint["minimumWordConfidence"] or end <= start or end - start > 12:
                raise AcousticAlignmentError(f"A source word failed acoustic alignment confidence or duration checks at UTF-16 offset {word['charStart']}. No approximate cue was saved.")
            words.append({"charStart": word["charStart"], "charEnd": word["charEnd"],
                          "startSeconds": start, "endSeconds": end, "confidence": round(confidence, 6)})
        if words and sum(word["confidence"] for word in words) / len(words) < self.fingerprint["minimumMeanConfidence"]:
            raise AcousticAlignmentError("The sentence failed mean acoustic alignment confidence. No approximate timings were produced.")
        return words
