import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const { parseFallbackDictionaryEntry } = loadTypeScript("src/lib/dictionary-response.ts");
const sense = (definition, subsenses = [], examples = []) => ({ definition, subsenses, examples });
const source = { url: "https://en.wiktionary.org/wiki/subtle", license: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } };
const entry = (partOfSpeech, senses) => ({ language: { code: "en", name: "English" }, partOfSpeech, pronunciations: [{ type: "ipa", text: "/ˈsʌtəl/", tags: [] }], senses });
const response = (entries) => ({ word: "subtle", entries, source });

test("the provider's subtle category groups show their real definitions in source order", () => {
  // Reduced fixture from FreeDictionaryAPI.com, sourced from the linked Wiktionary page under CC BY-SA 4.0.
  const definitions = [
    "Of an action or movement: very delicate or slight, and thus barely noticeable; not obvious; inconspicuous, unintrusive.",
    "(archaic) Having a delicate or fine substance or texture; hence, exquisite, refined.",
    "Of an argument or concept, words, etc.: requiring one to distinguish between fine points, especially if it is difficult to do so; nice; also (generally), difficult to grasp; not easily understood or obvious.",
    "Giving only a slight impression; elusive, indistinct; also, skilfully restrained or understated.",
  ];
  const example = "The difference between the tones is subtle, but you can hear it if you listen carefully.";
  const noun = "People or things that are subtle (adjective sense) as a class.";
  const result = parseFallbackDictionaryEntry(response([
    entry("adjective", [
      sense("Senses relating to tangible things.", [sense(definitions[0]), sense(definitions[1])]),
      sense("Senses relating to intangible things.", [sense(definitions[2]), sense(definitions[3], [], [example])]),
    ]),
    entry("noun", [sense(noun)]),
  ]), "subtle");
  assert.deepEqual(plain(result.meanings[0].definitions.map((item) => item.definition)), definitions);
  assert.equal(result.meanings[0].definitions[0].definition, definitions[0]);
  assert.equal(result.meanings[0].definitions[3].example, example);
  assert.equal(result.meanings[1].definitions[0].definition, noun);
  assert.equal(result.providerName, "FreeDictionaryAPI.com");
  assert.equal(result.sourceUrl, source.url);
  assert.deepEqual(plain(result.licence), source.license);
});

test("category groups with no usable children cannot masquerade as definitions or discard other meanings", () => {
  const group = sense("Senses relating to tangible things.", [null, {}, sense(42), sense("x".repeat(2001))]);
  assert.throws(() => parseFallbackDictionaryEntry(response([entry("adjective", [group])]), "subtle"), (error) => error.status === 502);
  assert.throws(() => parseFallbackDictionaryEntry(response([entry("adjective", [sense("Senses relating to intangible things.")])]), "subtle"), (error) => error.status === 502);
  const result = parseFallbackDictionaryEntry(response([
    entry("adjective", [group]), entry("noun", [sense("People or things that are subtle as a class.")]),
  ]), "subtle");
  assert.equal(result.meanings.length, 1);
  assert.equal(result.meanings[0].partOfSpeech, "noun");
  assert.equal(result.meanings[0].definitions[0].definition, "People or things that are subtle as a class.");
});

test("meaningful parents remain first and category headings do not consume the existing definition limit", () => {
  const childDefinitions = Array.from({ length: 10 }, (_, index) => `Specific meaning ${index + 1}.`);
  const result = parseFallbackDictionaryEntry(response([entry("adjective", [
    sense("A slight but meaningful difference.", [sense("A narrower genuine meaning.")]),
    sense("Senses relating to intangible things.", childDefinitions.map((definition) => sense(definition))),
  ])]), "subtle");
  assert.deepEqual(plain(result.meanings[0].definitions.map((item) => item.definition)), [
    "A slight but meaningful difference.", "A narrower genuine meaning.", ...childDefinitions.slice(0, 6),
  ]);
  assert.equal(result.meanings[0].definitions.length, 8);
});
