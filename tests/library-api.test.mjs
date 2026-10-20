import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain, testBooks } from "./helpers/load-typescript.mjs";

function storeHarness() {
  const queries = [];
  let rows = [[], [], []];
  const sql = (parts, ...values) => {
    queries.push({ text: parts.join("?"), values });
    return Promise.resolve([]);
  };
  sql.transaction = async () => rows;
  const content = {
    editionId: "edition-a",
    chapters: [
      { title: "Start", paragraphs: ["First paragraph.", "Second paragraph.", "Start 😀 then words."] },
      { title: "Next", paragraphs: ["Third paragraph."] },
    ],
  };
  const store = loadTypeScript("src/lib/library-store.ts", {
    stubs: {
      "server-only": {},
      "@neondatabase/serverless": { neon: () => sql },
      "@/data/books": { books: testBooks },
      "@/lib/book-content": { getBookContent: async () => content },
      "@/lib/epub-location": loadTypeScript("src/lib/epub-location.ts"),
    },
    env: { DATABASE_URL: "test-only-connection" },
  });
  return { store, queries, setRows(value) { rows = value; } };
}

test("auth callbacks accept local reader locations and reject external or recursive destinations", () => {
  const auth = loadTypeScript("src/auth.ts", {
    stubs: { "next-auth": () => ({}), "next-auth/providers/github": () => ({}) },
  });
  for (const path of [
    "https://evil.example", "//evil.example", "/%2f%2fevil.example",
    "/read/%5c%5cevil", "/read/%0aattack", "/%2e%2e/api/auth/callback/github",
    "/sign-in", "/read/%", undefined, ["/read/atomic-habits"],
  ]) assert.equal(auth.safeCallbackPath(path), "/", String(path));
  assert.equal(auth.safeCallbackPath("/read/atomic-habits?chapter=1&paragraph=4#passage"), "/read/atomic-habits?chapter=1&paragraph=4#passage");
});

test("library input rejects missing fields, unknown books, old editions and invalid coordinates", () => {
  const { store } = storeHarness();
  for (const value of [
    null,
    {},
    { type: "save-book", bookId: "unknown", saved: true, expectedUserId: "A" },
    { type: "save-book", bookId: "atomic-habits", saved: "true", expectedUserId: "A" },
    { type: "progress", bookId: "atomic-habits", editionId: "old-edition", chapterIndex: 0, paragraphIndex: 0, expectedUserId: "A" },
    { type: "progress", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0, paragraphIndex: -1, expectedUserId: "A" },
    { type: "progress", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0.5, paragraphIndex: 0, expectedUserId: "A" },
  ]) assert.throws(() => store.parseLibraryAction(value), (error) => error.status === 400);
  assert.equal(store.parseLibraryAction({ type: "save-book", bookId: "atomic-habits", saved: true, expectedUserId: "A" }).saved, true);
});

test("API enforces session ownership, same-origin writes and actual JSON body limits", async () => {
  const { store } = storeHarness();
  let activeUser = "A";
  let configured = true;
  let authCalls = 0;
  const calls = [];
  const mockAuth = {
    get authConfigured() { return configured; },
    auth: async () => { authCalls++; return activeUser ? { user: { id: activeUser } } : null; },
  };
  const api = loadTypeScript("src/app/api/library/route.ts", {
    stubs: {
      "@/auth": mockAuth,
      "@/lib/library-store": {
        ...store,
        getLibraryState: async (id) => { calls.push(["get", id]); return {}; },
        applyLibraryAction: async (id, action) => calls.push(["post", id, action]),
      },
    },
  });
  const post = (body, origin = "https://readlay.test", contentType = "application/json") => api.POST(new Request("https://readlay.test/api/library", {
    method: "POST",
    headers: { origin, "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  const action = { type: "save-book", bookId: "atomic-habits", saved: true, expectedUserId: "A" };
  assert.equal((await post(action)).status, 200);
  assert.equal(calls[0][1], "A");
  assert.equal((await post({ ...action, expectedUserId: "B" })).status, 401);
  assert.equal((await post(action, "https://evil.test")).status, 400);
  assert.equal((await post(" ".repeat(16 * 1024 + 1))).status, 400);
  assert.equal((await post("{invalid-json}")).status, 400);
  assert.equal((await post(action, "https://readlay.test", "text/plain")).status, 400);
  assert.equal((await api.GET(new Request("https://readlay.test/api/library?expectedUserId=B"))).status, 401);
  configured = false;
  const previousAuthCalls = authCalls;
  assert.equal((await api.GET(new Request("https://readlay.test/api/library"))).status, 401);
  assert.equal(authCalls, previousAuthCalls, "unconfigured auth must not initialise a session request");
  configured = true;
  activeUser = null;
  assert.equal((await post(action)).status, 401);
  assert.equal(calls.length, 1, "rejected requests must not reach storage");
  const response = await api.GET(new Request("https://readlay.test/api/library"));
  assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("store checks real paragraph bounds before SQL and uses the authenticated identity", async () => {
  const { store, queries } = storeHarness();
  const action = { type: "progress", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0, paragraphIndex: 999, expectedUserId: "untrusted-user" };
  await assert.rejects(store.applyLibraryAction("authenticated-user", action), (error) => error.status === 400);
  assert.equal(queries.length, 0);
  await store.applyLibraryAction("authenticated-user", { ...action, paragraphIndex: 1 });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].values[0], "authenticated-user");
  assert.equal(queries[0].values.includes("untrusted-user"), false);
});

test("store filters old editions and invalid rows and hydrates bookmarks from book text", async () => {
  const { store, queries, setRows } = storeHarness();
  setRows([
    [
      { book_id: "atomic-habits", edition_id: "edition-a", chapter_index: 0, paragraph_index: 1 },
      { book_id: "atomic-habits", edition_id: "old-edition", chapter_index: 0, paragraph_index: 0 },
    ],
    [{ book_id: "atomic-habits" }, { book_id: "unknown" }],
    [
      { book_id: "atomic-habits", edition_id: "edition-a", chapter_index: 0, paragraph_index: 1 },
      { book_id: "atomic-habits", edition_id: "edition-a", chapter_index: 0, paragraph_index: 999 },
    ],
  ]);
  const state = await store.getLibraryState("authenticated-user");
  assert.equal(queries.length, 3);
  assert.equal(queries.every((query) => query.values[0] === "authenticated-user"), true);
  assert.equal(state.bookmarks.length, 1);
  assert.equal(state.bookmarks[0].text, "Second paragraph.");
  assert.equal(state.bookmarks[0].chapterTitle, "Start");
  assert.equal(Object.keys(state.progressByEdition).length, 1);
  assert.equal(state.savedIds.length, 1);
  assert.equal(state.lastReadBookId, "atomic-habits");
  assert.deepEqual(plain(state.progressByEdition["atomic-habits:edition-a"]), {
    chapterIndex: 0, paragraphIndex: 1, charOffset: 0,
    cfi: "epubcfi(/6/2[chapter-1]!/4/4/1:0)",
  }, "legacy paragraph positions resume at offset 0");
});

test("word progress round-trips exact offsets and derives its CFI from authenticated coordinates", async () => {
  const { store, queries, setRows } = storeHarness();
  const input = { type: "progress", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0, paragraphIndex: 2, charOffset: 8, cfi: "epubcfi(/6/2[chapter-1]!/4/6/1:8)", expectedUserId: "untrusted-user" };
  const action = store.parseLibraryAction(input);
  await store.applyLibraryAction("authenticated-user", action);
  assert.match(queries[0].text, /char_offset/);
  assert.deepEqual(plain(queries[0].values), ["authenticated-user", "atomic-habits", "edition-a", 0, 2, 8]);
  setRows([[{ book_id: "atomic-habits", edition_id: "edition-a", chapter_index: 0, paragraph_index: 2, char_offset: 8 }], [], []]);
  const state = await store.getLibraryState("authenticated-user");
  assert.deepEqual(plain(state.progressByEdition["atomic-habits:edition-a"]), {
    chapterIndex: 0, paragraphIndex: 2, charOffset: 8,
    cfi: "epubcfi(/6/2[chapter-1]!/4/6/1:8)",
  });
});

test("word progress rejects malformed offsets and mismatched or malicious CFI strings", async () => {
  const { store, queries } = storeHarness();
  const input = { type: "progress", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0, paragraphIndex: 2, expectedUserId: "A" };
  for (const charOffset of [-1, 0.25, null, "8", NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => store.parseLibraryAction({ ...input, charOffset }), error => error.status === 400, String(charOffset));
  }
  for (const cfi of [false, null, "javascript:alert(1)", "epubcfi(/6/2[chapter-1]!/4/6/1:4)", "epubcfi(/6/4[chapter-2]!/4/6/1:8)", "epubcfi(/6/2[chapter-1]!/4/4/1:8)"]) {
    assert.throws(() => store.parseLibraryAction({ ...input, charOffset: 8, cfi }), error => error.status === 400, String(cfi));
  }
  // Structural parsing is deliberately separate from checking the private book text.
  for (const charOffset of [7, 100]) {
    const action = store.parseLibraryAction({ ...input, charOffset });
    await assert.rejects(store.applyLibraryAction("A", action), error => error.status === 400);
  }
  assert.equal(queries.length, 0, "invalid positions must never write to storage");
});

test("invalid persisted word offsets are filtered without exposing broken locations", async () => {
  const { store, setRows } = storeHarness();
  for (const charOffset of [-1, 7, 100, null]) {
    setRows([[{ book_id: "atomic-habits", edition_id: "edition-a", chapter_index: 0, paragraph_index: 2, char_offset: charOffset }], [], []]);
    const state = await store.getLibraryState("A");
    assert.deepEqual(plain(state.progressByEdition), {});
    assert.equal(state.lastReadBookId, null);
  }
});
