type Sound = { ipa: string; spelling: string; vowel: boolean; short?: boolean };
type Part = { sounds: Sound[]; stress: boolean };

// A deliberately limited English sound inventory. This is a reading aid, not a
// replacement for recorded pronunciation. Unknown notation must not be guessed.
const vowels: Record<string, string> = {
  "eɪ": "ay", "aɪ": "eye", "ɔɪ": "oy", "əʊ": "oh", "oʊ": "oh", "aʊ": "ow",
  "ɪə": "eer", "eə": "air", "ɛə": "air", "ʊə": "oor",
  "iː": "ee", "uː": "oo", "ɑː": "ah", "ɔː": "aw", "ɜː": "ur",
  "ɑ": "ah", "ɔ": "aw", "ɜ": "ur", "ɝ": "ur", "ɚ": "ur", "æ": "a", "ɛ": "e", "e": "e",
  "ɪ": "i", "ɒ": "o", "ʌ": "uh", "ɐ": "uh", "ə": "uh", "ʊ": "uu", "i": "ee", "u": "oo",
  "l̩": "uhl", "n̩": "uhn", "m̩": "uhm",
};
const consonants: Record<string, string> = {
  "tʃ": "ch", "dʒ": "j", "ʧ": "ch", "ʤ": "j", "ʃ": "sh", "ʒ": "zh",
  "θ": "th", "ð": "dh", "ŋ": "ng", "ɹ": "r", "ɡ": "g", "ɫ": "l",
  p: "p", b: "b", t: "t", d: "d", k: "k", g: "g", f: "f", v: "v",
  s: "s", z: "z", h: "h", m: "m", n: "n", l: "l", r: "r", j: "y", w: "w",
};
const shortVowels = new Set(["æ", "ɛ", "e", "ɪ", "ɒ", "ʌ", "ɐ", "ʊ"]);
const keys = [...Object.keys(vowels), ...Object.keys(consonants)].sort((a, b) => b.length - a.length);
const complexOnsets = new Set([
  "pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "gl", "gr", "fl", "fr", "θr", "ʃr",
  "sp", "st", "sk", "sm", "sn", "sl", "sw", "tw", "kw", "dw", "gw",
  "pj", "bj", "tj", "dj", "kj", "gj", "fj", "vj", "θj", "mj", "nj", "lj", "hj",
  "spl", "spr", "str", "skr", "skw", "spj", "stj", "skj",
]);

function syllables(part: Part): Sound[][] {
  const nuclei = part.sounds.flatMap((sound, index) => sound.vowel ? [index] : []);
  if (!nuclei.length) return [];
  const boundaries = [0];
  for (let index = 0; index < nuclei.length - 1; index++) {
    const current = nuclei[index];
    const next = nuclei[index + 1];
    const between = part.sounds.slice(current + 1, next);
    let onsetLength = 0;
    for (let length = Math.min(3, between.length); length > 0; length--) {
      const onset = between.slice(-length).map((sound) => sound.ipa.replace(/ɹ/g, "r").replace(/ɡ/g, "g")).join("");
      if ((length === 1 && onset !== "ŋ") || complexOnsets.has(onset)) { onsetLength = length; break; }
    }
    // Keep a short stressed vowel closed: HAB-it and LIT-uhl. Long vowels
    // retain the following onset: JEE-nee-uhl. Explicit IPA dots take priority.
    if (between.length > 0 && part.stress && index === 0 && part.sounds[current].short && onsetLength === between.length) onsetLength--;
    boundaries.push(next - onsetLength);
  }
  boundaries.push(part.sounds.length);
  return boundaries.slice(0, -1).map((start, index) => part.sounds.slice(start, boundaries[index + 1]));
}

/**
 * Convert one supported English IPA transcription to an approximate respelling.
 * Capitals identify primary stress; hyphens divide approximate syllables.
 * The caller must describe the result as approximate. This does not infer a
 * pronunciation from a word's spelling and returns null for unsupported input.
 */
export function pronunciationRespelling(phonetic: string | null | undefined): string | null {
  if (typeof phonetic !== "string" || !phonetic.trim() || phonetic.length > 200) return null;
  let source = phonetic.trim().normalize("NFC");
  if ((source.startsWith("/") && source.endsWith("/")) || (source.startsWith("[") && source.endsWith("]"))) source = source.slice(1, -1);
  if (!source || /[\s/\[\]]/.test(source)) return null;
  // Both dictionary providers use tied affricates. The optional GOAT glide is
  // also supplied as ə(ʊ); choose its complete vowel rather than split it.
  source = source.replace(/t[\u0361\u035c]ʃ/g, "tʃ").replace(/d[\u0361\u035c]ʒ/g, "dʒ").replace(/ə\(ʊ\)/g, "əʊ");
  const parts: Part[] = [];
  let current: Part = { sounds: [], stress: false };
  let primaryCount = 0;
  let stressCount = 0;
  let pendingStress = false;
  for (let position = 0; position < source.length;) {
    const character = source[position];
    if (character === "." || character === "ˈ" || character === "ˌ") {
      if (current.sounds.length) { parts.push(current); current = { sounds: [], stress: false }; pendingStress = false; }
      else if (character === "." && (position === 0 || source[position - 1] === ".")) return null;
      if (character !== ".") {
        if (pendingStress) return null;
        pendingStress = true;
        stressCount++;
        current.stress = character === "ˈ";
        if (current.stress && ++primaryCount > 1) return null;
      }
      position++;
      continue;
    }
    const key = keys.find((candidate) => source.startsWith(candidate, position));
    if (!key) return null;
    const vowel = Object.hasOwn(vowels, key);
    current.sounds.push({ ipa: key, spelling: vowel ? vowels[key] : consonants[key], vowel, short: shortVowels.has(key) });
    position += key.length;
  }
  if (!current.sounds.length) return null;
  parts.push(current);
  const result: string[] = [];
  for (const part of parts) {
    const split = syllables(part);
    if (!split.length) return null;
    for (let index = 0; index < split.length; index++) {
      let spelling = split[index].map((sound, soundIndex) => sound.ipa === "aɪ" && soundIndex > 0 ? "y" : sound.spelling).join("");
      if (part.stress && index === 0) spelling = spelling.toUpperCase();
      result.push(spelling);
    }
  }
  // Monosyllables often have no explicit stress mark in dictionary IPA.
  return result.length === 1 && !stressCount ? result[0].toUpperCase() : result.join("-");
}
