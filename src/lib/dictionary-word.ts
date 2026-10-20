// These helpers also run in the reader. They never need book content or a session.
export function normaliseDictionaryWord(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 256 || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return null;
  const word = raw.normalize("NFC").trim().toLowerCase()
    .replace(/[’‘ʼ]/g, "'").replace(/[‐‑]/g, "-")
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
  const lexical = /^(?:\p{L}\p{M}*)+(?:['-](?:\p{L}\p{M}*)+)*$/u.test(word);
  const latinLetters = [...word].every((character) => !/\p{L}/u.test(character) || /\p{Script=Latin}/u.test(character));
  return word.length > 0 && word.length <= 80 && lexical && latinLetters ? word : null;
}

const irregular: Record<string, string> = {
  children: "child", feet: "foot", geese: "goose", men: "man", mice: "mouse", people: "person",
  teeth: "tooth", women: "woman", went: "go", gone: "go", better: "good", best: "good",
  worse: "bad", worst: "bad", analyses: "analysis", theses: "thesis", crises: "crisis",
  lying: "lie", dying: "die", tying: "tie", was: "be", were: "be", been: "be", had: "have", did: "do", done: "do",
};

// Only try these when the API cannot find the original form. Each result is a real lookup.
export function inflectionCandidates(raw: unknown): string[] {
  const word = normaliseDictionaryWord(raw);
  if (!word) return [];
  const candidates = [word];
  const add = (candidate: string) => {
    if (candidate.length >= 2 && normaliseDictionaryWord(candidate) === candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  if (word.endsWith("'s")) add(word.slice(0, -2));
  if (irregular[word]) add(irregular[word]);
  if (word.length > 4 && word.endsWith("ies")) add(`${word.slice(0, -3)}y`);
  else if (/(?:ss|sh|ch|x|z)es$/.test(word)) add(word.slice(0, -2));
  else if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) add(word.slice(0, -1));
  if (word.length > 5 && word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    if (/([^aeiou])\1$/.test(stem)) add(stem.slice(0, -1));
    add(`${stem}e`); add(stem);
  } else if (word.length > 4 && word.endsWith("ied")) add(`${word.slice(0, -3)}y`);
  else if (word.length > 4 && word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    if (/([^aeiou])\1$/.test(stem)) add(stem.slice(0, -1));
    add(word.slice(0, -1)); add(stem);
  }
  return candidates.slice(0, 5);
}

export function safePronunciationUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    const allowed = (url.hostname === "api.dictionaryapi.dev" && /^\/media\/pronunciations\/en\/[\p{Script=Latin}\p{M}0-9_.-]+\.mp3$/iu.test(path))
      || (url.hostname === "ssl.gstatic.com" && /^\/dictionary\/static\/sounds\/[a-z0-9_./-]+\.mp3$/i.test(url.pathname));
    return allowed ? url.href : null;
  } catch { return null; }
}

export function safeDictionarySourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
