import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const date = "2026-10-22T00:00:00.000Z";
const source = { word: "habit", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0, paragraphIndex: 0, charStart: 2, charEnd: 7 };
const entry = { word: "habit", phonetic: null, audioUrl: null, meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "A repeated action." }] }], sourceUrl: null, licence: null };
function savedWord(word = "habit") {
  return { id: `word-${word}`, word, entry: { ...entry, word }, status: "new", savedAt: date, updatedAt: date,
    occurrences: [{ id: `occurrence-${word}`, ...source, selectedText: word, sentence: "A habit grows.", savedAt: date,
      cfiStart: "epubcfi(/6/2[chapter-1]!/4/2/1:2)", cfiEnd: "epubcfi(/6/2[chapter-1]!/4/2/1:7)", cfiRange: "epubcfi(/6/2[chapter-1]!/4/2,/1:2,/1:7)" }] };
}
async function settle() { for (let n = 0; n < 15; n++) await new Promise(setImmediate); }

function harness() {
  const storage = new Map();
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  const window = { addEventListener: (...args) => events.addEventListener(...args), removeEventListener: (...args) => events.removeEventListener(...args) };
  const document = { visibilityState: "visible", addEventListener: (...args) => documentEvents.addEventListener(...args), removeEventListener: (...args) => documentEvents.removeEventListener(...args) };
  let active;
  const react = {
    createContext: () => ({ Provider: "Provider" }), useContext: () => null,
    useState(initial) {
      const current = active, index = current.cursor++;
      current.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [current.slots[index].value, (value) => { current.slots[index].value = typeof value === "function" ? value(current.slots[index].value) : value; }];
    },
    useRef(initial) {
      const current = active, index = current.cursor++;
      current.slots[index] ??= { current: initial };
      return current.slots[index];
    },
    useEffect(fn, deps) {
      const current = active, index = current.cursor++;
      const previous = current.slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        current.slots[index] = { deps, cleanup: previous?.cleanup };
        current.effects.push(() => { current.slots[index].cleanup?.(); current.slots[index].cleanup = fn(); });
      }
    },
  };
  let sessionUser = "A";
  let offline = false;
  let hold;
  let holdWrite;
  const remotes = new Map();
  const calls = [];
  async function fetch(path, options) {
    calls.push({ path, options: { ...options, signal: undefined } });
    if (offline) throw new TypeError("Offline");
    const url = new URL(path, "https://readlay.test");
    const body = options.method === "POST" ? JSON.parse(options.body) : null;
    const expected = body?.expectedUserId ?? url.searchParams.get("expectedUserId");
    if (expected !== sessionUser) return Response.json({ error: "Your GitHub session changed." }, { status: 401 });
    let words = plain(remotes.get(sessionUser) ?? []);
    if (body?.action === "save") {
      words = [savedWord()];
      remotes.set(sessionUser, words);
    } else if (body?.action === "remove") {
      words = words.filter((word) => word.id !== body.id); remotes.set(sessionUser, words);
    } else if (body?.action === "status") {
      words = words.map((word) => word.id === body.id ? { ...word, status: body.status } : word); remotes.set(sessionUser, words);
    }
    const response = Response.json({ words });
    if (!body && hold) { const pause = hold; hold = null; await pause.promise; }
    if (body && holdWrite) { const pause = holdWrite; holdWrite = null; await pause.promise; }
    return response;
  }
  const provider = loadTypeScript("src/components/WordBankProvider.tsx", {
    extra: "\nexport const __test = { AccountWordBank };",
    stubs: { react, "react/jsx-runtime": { jsx: (type, props, key) => ({ type, props, key }) },
      "next-auth/react": { useSession: () => ({ data: sessionUser ? { user: { id: sessionUser } } : null, status: sessionUser ? "authenticated" : "unauthenticated" }) } },
    globals: { window, document, fetch, Error, TypeError, localStorage: { setItem: (key, value) => storage.set(key, value) } },
  });
  const mounted = new Set();
  function mount(userId = "A") {
    const tab = { userId, slots: [], effects: [], cursor: 0,
      render() {
        tab.cursor = 0; active = tab;
        const tree = provider.__test.AccountWordBank({ userId: tab.userId, sessionReady: true, children: null });
        active = null; tab.effects.splice(0).forEach((fn) => fn());
        return tree.props.value;
      },
      unmount() { for (const slot of tab.slots) slot.cleanup?.(); mounted.delete(tab); },
    };
    mounted.add(tab); tab.render(); return tab;
  }
  return { mount, remotes, calls, storage, provider,
    setUser(user) { sessionUser = user; }, setOffline(value) { offline = value; },
    holdNextRead() { let release; hold = { promise: new Promise((resolve) => { release = resolve; }) }; return release; },
    holdNextWrite() { let release; holdWrite = { promise: new Promise((resolve) => { release = resolve; }) }; return release; },
    focus() { events.dispatchEvent(new Event("focus")); },
    invalidate() { const event = new Event("storage"); Object.defineProperty(event, "key", { value: `readlay-word-bank:${sessionUser}:invalidate` }); events.dispatchEvent(event); },
    cleanup() { for (const tab of mounted) tab.unmount(); },
  };
}

test("Word Bank isolates account state and does not persist guest vocabulary or source text", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  app.remotes.set("A", [savedWord()]);
  const first = app.mount(); await settle();
  assert.equal(first.render().words[0].word, "habit");
  assert.equal(app.provider.WordBankProvider({ children: null }).key, "github:A");
  first.unmount(); app.setUser("B");
  assert.equal(app.provider.WordBankProvider({ children: null }).key, "github:B");
  const second = app.mount("B");
  assert.equal(second.render().words.length, 0, "previous account data must never flash"); await settle();
  assert.equal(second.render().ready, true);
  assert.equal(second.render().words.length, 0);
  second.unmount(); app.setUser(null);
  const count = app.calls.length, guest = app.mount(null); await settle();
  assert.equal(guest.render().ready, true);
  assert.equal(guest.render().isSignedIn, false);
  await assert.rejects(guest.render().saveWord(source), /Sign in with GitHub/);
  assert.equal(app.calls.length, count);
  assert.equal(app.storage.size, 0);
});

test("save, status and remove immediately adopt the authoritative snapshot and publish only invalidation markers", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  const tab = app.mount(); await settle();
  const saved = await tab.render().saveWord({ ...source, entry });
  assert.equal(saved.word, "habit");
  const sent = JSON.parse(app.calls.find((call) => call.options.method === "POST").options.body);
  assert.equal(sent.entry.meanings[0].definitions[0].definition, entry.meanings[0].definitions[0].definition);
  assert.equal(tab.render().words.length, 1);
  await tab.render().setWordStatus(saved.id, "learning");
  assert.equal(tab.render().words[0].status, "learning");
  await tab.render().removeWord(saved.id);
  assert.equal(tab.render().words.length, 0);
  assert.equal(app.storage.size, 1);
  for (const [key, value] of app.storage) {
    assert.equal(key, "readlay-word-bank:A:invalidate");
    assert.match(value, /^[0-9a-f-]{36}$/);
    assert.ok(!value.includes("habit"));
  }
  for (const call of app.calls) {
    assert.ok(call.path.startsWith("/api/word-bank"), "vocabulary changes must never update reading progress");
    assert.equal(call.options.credentials, "same-origin");
    assert.equal(call.options.cache, "no-store");
  }
});

test("refreshes cannot overwrite queued saves and focus/storage events collect another device's changes", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  const release = app.holdNextRead();
  const tab = app.mount(); await settle();
  const saving = tab.render().saveWord(source);
  await settle();
  assert.equal(app.calls.length, 1, "mutation must wait for the earlier snapshot");
  release(); await saving;
  assert.equal(tab.render().words[0].word, "habit");
  app.remotes.set("A", []); app.invalidate(); await settle();
  assert.equal(tab.render().words.length, 0);
  app.remotes.set("A", [savedWord()]); app.focus(); await settle();
  assert.equal(tab.render().words[0].word, "habit");
});

test("failed requests are visible, retry recovers, and late account responses cannot leak vocabulary", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  app.setOffline(true); const tab = app.mount(); await settle();
  assert.equal(tab.render().ready, true);
  assert.equal(tab.render().error, "Offline");
  await assert.rejects(tab.render().saveWord(source), /Offline/);
  app.setOffline(false); await tab.render().refresh();
  assert.equal(tab.render().error, null);
  app.setUser("B");
  await assert.rejects(tab.render().saveWord(source), /session changed/);
  assert.equal(app.remotes.has("B"), false);
  tab.unmount(); app.setUser("A"); app.remotes.set("A", [savedWord()]);
  const release = app.holdNextRead(); const old = app.mount(); await settle(); old.unmount();
  app.setUser("B"); const next = app.mount("B"); await settle(); release(); await settle();
  assert.equal(next.render().words.length, 0);
  assert.equal(old.render().words.length, 0, "unmounted provider must not adopt a late snapshot");
});

test("an account change during a committed save discards the old mutation response", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  const first = app.mount(); await settle();
  const release = app.holdNextWrite();
  const pending = first.render().saveWord(source);
  const rejected = assert.rejects(pending, (error) => error.name === "AbortError");
  await settle();
  assert.equal(app.remotes.get("A")[0].word, "habit", "the request can finish for its original account");
  first.unmount(); app.setUser("B");
  const second = app.mount("B"); await settle();
  release(); await rejected; await settle();
  assert.equal(second.render().words.length, 0);
  assert.equal(second.render().error, null);
  assert.equal(first.render().words.length, 0, "late mutation data must not be adopted");
  assert.equal(app.storage.size, 0, "late mutation data must not broadcast into another account");
});
