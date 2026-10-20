import assert from "node:assert/strict";
import test from "node:test";
import { emptyLibrary, loadTypeScript, plain, testBooks } from "./helpers/load-typescript.mjs";

function syncHarness() {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  const window = {
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    setInterval: () => 1,
    clearInterval() {},
    location: { pathname: "/", search: "", hash: "" },
  };
  const document = {
    visibilityState: "visible",
    addEventListener: (...args) => documentEvents.addEventListener(...args),
    removeEventListener: (...args) => documentEvents.removeEventListener(...args),
  };
  const locks = new Map();
  const navigator = { locks: {
    async request(name, options, action) {
      const previous = locks.get(name) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => {
        if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
        return action();
      });
      locks.set(name, next);
      return next;
    },
  } };
  let activeHarness;
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    useContext: () => null,
    useState(initial) {
      const harness = activeHarness;
      const index = harness.cursor++;
      harness.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [harness.slots[index].value, (value) => {
        const slot = harness.slots[index];
        slot.value = typeof value === "function" ? value(slot.value) : value;
      }];
    },
    useRef(initial) {
      const harness = activeHarness;
      const index = harness.cursor++;
      harness.slots[index] ??= { current: initial };
      return harness.slots[index];
    },
    useEffect(fn, deps) {
      const harness = activeHarness;
      const index = harness.cursor++;
      const previous = harness.slots[index];
      if (!previous || deps.some((value, n) => !Object.is(value, previous.deps[n]))) {
        harness.slots[index] = { deps, cleanup: previous?.cleanup };
        harness.effects.push(() => {
          harness.slots[index].cleanup?.();
          harness.slots[index].cleanup = fn();
        });
      }
    },
  };
  const remotes = new Map();
  let sessionUser = "A";
  let offline = false;
  const sends = [];
  // Model the service contract independently of the client state reducer.
  async function fetch(url, options) {
    if (offline) throw new TypeError("Offline");
    if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const address = new URL(url, "https://readlay.test");
    const body = options.method === "POST" ? JSON.parse(options.body) : null;
    const expected = body?.expectedUserId ?? address.searchParams.get("expectedUserId");
    if (expected !== sessionUser) return Response.json({}, { status: 401 });
    const state = plain(remotes.get(sessionUser) || emptyLibrary());
    if (!body) return Response.json(state);
    const action = { ...body };
    delete action.expectedUserId;
    sends.push(action);
    if (action.type === "save-book") {
      state.savedIds = state.savedIds.filter((id) => id !== action.bookId);
      if (action.saved) state.savedIds.push(action.bookId);
    } else if (action.type === "progress") {
      state.progressByEdition[`${action.bookId}:${action.editionId}`] = { chapterIndex: action.chapterIndex, paragraphIndex: action.paragraphIndex };
      state.lastReadBookId = action.bookId;
    } else if (action.type === "bookmark") {
      const id = `${action.bookId}:${action.editionId}:${action.chapterIndex}:${action.paragraphIndex}`;
      state.bookmarks = state.bookmarks.filter((passage) => passage.id !== id);
      if (action.saved) state.bookmarks.push({ id, bookId: action.bookId, editionId: action.editionId, chapterIndex: action.chapterIndex, paragraphIndex: action.paragraphIndex, text: "Authoritative book text", chapterTitle: "Start" });
    }
    remotes.set(sessionUser, state);
    return Response.json({ ok: true });
  }
  const { __test: { ReadlayStateProvider } } = loadTypeScript("src/components/ReadlayProvider.tsx", {
    extra: "\nexport const __test = { ReadlayStateProvider };",
    stubs: {
      react,
      "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
      "next-auth/react": {},
      "next/navigation": { useRouter: () => ({ push() {} }) },
      "@/data/books": { books: testBooks },
    },
    globals: { window, document, navigator, localStorage, fetch },
  });
  const mounted = new Set();
  function createHarness(userId) {
    const harness = {
      userId,
      slots: [],
      effects: [],
      cursor: 0,
      render() {
        harness.cursor = 0;
        activeHarness = harness;
        const tree = ReadlayStateProvider({ children: null, userId: harness.userId, sessionReady: true });
        activeHarness = null;
        harness.effects.splice(0).forEach((fn) => fn());
        return tree.props.value;
      },
      unmount() {
        for (const slot of harness.slots) slot.cleanup?.();
        mounted.delete(harness);
      },
    };
    mounted.add(harness);
    harness.render();
    return harness;
  }
  return {
    mount: (userId = "A") => createHarness(userId),
    storage,
    remotes,
    sends,
    setOffline(value) { offline = value; },
    setUser(value) { sessionUser = value; },
    reconnect() { offline = false; events.dispatchEvent(new Event("online")); },
    cleanup() { for (const harness of mounted) harness.unmount(); },
  };
}
async function settle() { for (let n = 0; n < 20; n++) await new Promise(setImmediate); }

// These tests exercise the actual provider effects with deterministic hooks and services.
// They complement browser tests; they do not claim to exercise React rendering or OAuth.
test("server state takes priority over an old browser cache on sign-in", async (t) => {
  const app = syncHarness(); t.after(() => app.cleanup());
  app.storage.set("readlay-v4:github:A", JSON.stringify({ base: { ...emptyLibrary(), savedIds: ["power-of-now"] }, pending: [] }));
  app.remotes.set("A", { ...emptyLibrary(), savedIds: ["atomic-habits"] });
  const tab = app.mount(); await settle();
  assert.equal(tab.render().ready, true);
  assert.equal(tab.render().syncStatus, "synced");
  assert.deepEqual(plain(tab.render().savedIds), ["atomic-habits"]);
  assert.equal(app.sends.length, 0);
});

test("offline edits survive a remount and preserve another device's progress on retry", async (t) => {
  const app = syncHarness(); t.after(() => app.cleanup());
  app.remotes.set("A", { ...emptyLibrary(), savedIds: ["atomic-habits"] });
  let tab = app.mount(); await settle();
  app.setOffline(true); tab.render().toggleSaved("atomic-habits"); await settle();
  assert.equal(tab.render().syncStatus, "error");
  assert.equal(JSON.parse(app.storage.get("readlay-v4:github:A")).pending.length, 1);
  tab.unmount();
  app.remotes.get("A").progressByEdition["atomic-habits:edition-a"] = { chapterIndex: 1, paragraphIndex: 0 };
  app.remotes.get("A").lastReadBookId = "atomic-habits";
  tab = app.mount(); await settle();
  assert.equal(tab.render().syncStatus, "error");
  app.reconnect(); await settle();
  assert.equal(tab.render().syncStatus, "synced");
  assert.equal(JSON.parse(app.storage.get("readlay-v4:github:A")).pending.length, 0);
  assert.deepEqual(app.remotes.get("A").savedIds, []);
  assert.equal(app.remotes.get("A").progressByEdition["atomic-habits:edition-a"].chapterIndex, 1);
});

test("parallel tabs retain both edits and receive authoritative bookmark text", async (t) => {
  const app = syncHarness(); t.after(() => app.cleanup());
  const first = app.mount(); const second = app.mount(); await settle();
  app.setOffline(true);
  first.render().toggleSaved("atomic-habits");
  second.render().toggleBookmark(0, 0, "Cached passage", "atomic-habits", "edition-a", "Start");
  await settle();
  assert.equal(JSON.parse(app.storage.get("readlay-v4:github:A")).pending.length, 2);
  app.reconnect(); await settle();
  assert.equal(JSON.parse(app.storage.get("readlay-v4:github:A")).pending.length, 0);
  assert.deepEqual(app.remotes.get("A").savedIds, ["atomic-habits"]);
  assert.equal(app.remotes.get("A").bookmarks[0].text, "Authoritative book text");
  assert.equal(app.sends.length, 2);
});

test("another account cannot see cached account data or import guest data", async (t) => {
  const app = syncHarness(); t.after(() => app.cleanup());
  app.storage.set("readlay-v4:github:A", JSON.stringify({ base: { ...emptyLibrary(), savedIds: ["atomic-habits"] }, pending: [] }));
  app.storage.set("readlay-v3", JSON.stringify({ ...emptyLibrary(), savedIds: ["power-of-now"] }));
  app.setUser("B");
  const account = app.mount("B"); await settle();
  assert.deepEqual(plain(account.render().savedIds), []);
  assert.equal(account.render().bookmarks.length, 0);
  assert.equal(account.render().isSignedIn, true);
  assert.equal(app.sends.length, 0);
  account.unmount();
  const guest = app.mount(null); await settle();
  assert.deepEqual(plain(guest.render().savedIds), ["power-of-now"]);
  assert.equal(guest.render().syncStatus, "local");
  assert.equal(guest.render().isSignedIn, false);
});
