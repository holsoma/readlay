import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { visibleWords, wordOccurrenceHref } = loadTypeScript('src/lib/wordbank-view.ts');
const { cfiForPosition } = loadTypeScript('src/lib/epub-location.ts');
const titles = new Map([['book-a', 'An Original Book'], ['book-b', 'Another Title']]);
function word(id, text, status, savedAt, occurrences = []) {
  return { id, word: text, status, savedAt, updatedAt: savedAt,
    entry: { word: text, meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: text === 'café' ? 'A place serving coffee.' : 'An original definition.' }] }] }, occurrences };
}
const words = [
  word('a', 'zest', 'learning', '2026-10-01T00:00:00Z', [{ bookId: 'book-a', selectedText: 'zest', sentence: 'She approached it with zest.' }]),
  word('b', 'café', 'new', '2026-10-03T00:00:00Z', [{ bookId: 'book-b', selectedText: 'café', sentence: 'They chose a quiet café.' }]),
  word('c', 'apt', 'learned', '2026-10-02T00:00:00Z'),
];

test('Word Bank searches accent-insensitively across definitions, contexts and book titles', () => {
  assert.deepEqual(Array.from(visibleWords(words, 'CAFE', 'all', 'newest', titles), item => item.id), ['b']);
  assert.deepEqual(Array.from(visibleWords(words, 'coffee', 'all', 'newest', titles), item => item.id), ['b']);
  assert.deepEqual(Array.from(visibleWords(words, 'original book zest', 'all', 'newest', titles), item => item.id), ['a']);
  assert.equal(visibleWords(words, 'missing', 'all', 'newest', titles).length, 0);
});

test('status filters and sort orders do not mutate the shared Word Bank', () => {
  const before = JSON.stringify(words);
  assert.deepEqual(Array.from(visibleWords(words, '', 'all', 'alphabetical', titles), item => item.id), ['c', 'b', 'a']);
  assert.deepEqual(Array.from(visibleWords(words, '', 'all', 'newest', titles), item => item.id), ['b', 'c', 'a']);
  assert.deepEqual(Array.from(visibleWords(words, '', 'learning', 'updated', titles), item => item.id), ['a']);
  assert.equal(JSON.stringify(words), before);
});

test('return links derive exact word locations from the matching canonical EPUB CFI', () => {
  const occurrence = { editionId: 'edition-a', chapterIndex: 2, paragraphIndex: 4, charStart: 53, cfiStart: cfiForPosition(2, 4, 53) };
  const book = { slug: 'an-original-book', editionId: 'edition-a' };
  assert.equal(wordOccurrenceHref(occurrence, book), '/read/an-original-book?chapter=2&paragraph=4&offset=53');
  assert.equal(wordOccurrenceHref(occurrence, { ...book, editionId: 'replacement-edition' }), null);
  assert.equal(wordOccurrenceHref({ ...occurrence, charStart: 54 }, book), null);
  assert.equal(wordOccurrenceHref({ ...occurrence, cfiStart: 'javascript:alert(1)' }, book), null);
  assert.equal(wordOccurrenceHref(occurrence, undefined), null);
});
