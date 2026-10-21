"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { books } from "@/data/books";
import { cfiForPosition, parseEpubCfi } from "@/lib/epub-location";
import type { LibraryAction, LibraryState, ReadingProgress, SavedPassage } from "@/lib/library-types";
import { cachedRetiredEditions, migrateCachedLibrary, parseEditionMigration, type EditionMigration } from "@/lib/edition-migration";

export type { ReadingProgress, SavedPassage } from "@/lib/library-types";
export type SyncStatus = "local" | "syncing" | "synced" | "error";
type QueuedAction = { id: string; action: LibraryAction; bookmark?: SavedPassage };
type CachedLibrary = { base: LibraryState; pending: QueuedAction[] };
type ReadlayContextValue = LibraryState & {
  ready: boolean;
  isSignedIn: boolean;
  syncStatus: SyncStatus;
  toggleSaved: (id: string) => void;
  getProgress: (bookId: string, editionId?: string) => ReadingProgress | null;
  saveProgress: (chapterIndex: number, paragraphIndex: number, bookId: string, editionId: string, charOffset?: number) => void;
  toggleBookmark: (chapterIndex: number, paragraphIndex: number, text: string, bookId: string, editionId: string, chapterTitle?: string) => void;
  openAuth: () => void;
  notify: (message: string) => void;
};
const ReadlayContext = createContext<ReadlayContextValue | null>(null);
const empty: LibraryState = { savedIds: [], progressByEdition: {}, bookmarks: [], lastReadBookId: null };
const knownBook = (id: string) => books.find((book) => book.id === id);
const editionFor = (bookId: string) => knownBook(bookId)?.editionId;
const locationKey = (bookId: string, editionId: string) => `${bookId}:${editionId}`;
const passageId = (bookId: string, editionId: string, chapterIndex: number, paragraphIndex: number) => `${locationKey(bookId, editionId)}:${chapterIndex}:${paragraphIndex}`;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validProgress(value: unknown): value is ReadingProgress & Record<string, unknown> {
  if (!record(value) || !Number.isSafeInteger(value.chapterIndex) || Number(value.chapterIndex) < 0 || !Number.isSafeInteger(value.paragraphIndex) || Number(value.paragraphIndex) < 0) return false;
  const offset = value.charOffset === undefined ? 0 : value.charOffset;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 2_147_483_647) return false;
  if (value.cfi !== undefined) {
    if (typeof value.cfi !== "string") return false;
    const parsed = parseEpubCfi(value.cfi);
    if (!parsed || parsed.chapterIndex !== value.chapterIndex || parsed.paragraphIndex !== value.paragraphIndex || parsed.charOffset !== offset) return false;
  }
  return true;
}
function preciseProgress(value: ReadingProgress): ReadingProgress {
  const charOffset = value.charOffset ?? 0;
  return { chapterIndex: value.chapterIndex, paragraphIndex: value.paragraphIndex, charOffset, cfi: cfiForPosition(value.chapterIndex, value.paragraphIndex, charOffset) };
}
function validLocation(bookId: string, editionId: string, progress: ReadingProgress) {
  const book = knownBook(bookId);
  return !!book && book.editionId === editionId && validProgress(progress) && (!book.chapterCount || progress.chapterIndex < book.chapterCount);
}
function parsePassage(value: unknown): SavedPassage | null {
  if (!record(value) || !validProgress(value) || typeof value.bookId !== "string" || typeof value.editionId !== "string" || typeof value.text !== "string" || !validLocation(value.bookId, value.editionId, value)) return null;
  return { id: passageId(value.bookId, value.editionId, value.chapterIndex, value.paragraphIndex), bookId: value.bookId, editionId: value.editionId, chapterIndex: value.chapterIndex, paragraphIndex: value.paragraphIndex, text: value.text, chapterTitle: typeof value.chapterTitle === "string" ? value.chapterTitle : `Chapter ${value.chapterIndex + 1}` };
}
function parseState(value: unknown): LibraryState {
  if (!record(value) || !Array.isArray(value.savedIds) || !Array.isArray(value.bookmarks)) return empty;
  const progressByEdition: LibraryState["progressByEdition"] = {};
  if (record(value.progressByEdition)) for (const book of books) {
    const editionId = book.editionId;
    if (!editionId) continue;
    const progress = value.progressByEdition[locationKey(book.id, editionId)];
    if (validProgress(progress) && validLocation(book.id, editionId, progress)) progressByEdition[locationKey(book.id, editionId)] = preciseProgress(progress);
  }
  const bookmarks = value.bookmarks.flatMap((item) => { const passage = parsePassage(item); return passage ? [passage] : []; });
  const lastId = value.lastReadBookId;
  const lastEdition = typeof lastId === "string" ? editionFor(lastId) : null;
  return { savedIds: [...new Set(value.savedIds.filter((id): id is string => typeof id === "string" && !!knownBook(id)))], progressByEdition, bookmarks, lastReadBookId: typeof lastId === "string" && lastEdition && progressByEdition[locationKey(lastId, lastEdition)] ? lastId : null };
}
function parseAction(value: unknown): LibraryAction | null {
  if (!record(value) || typeof value.bookId !== "string" || !knownBook(value.bookId)) return null;
  if (value.type === "save-book" && typeof value.saved === "boolean") return { type: value.type, bookId: value.bookId, saved: value.saved };
  if (typeof value.editionId !== "string" || !validProgress(value) || !validLocation(value.bookId, value.editionId, value)) return null;
  const position = { bookId: value.bookId, editionId: value.editionId, chapterIndex: value.chapterIndex, paragraphIndex: value.paragraphIndex };
  if (value.type === "progress") return { ...position, ...preciseProgress(value), type: value.type };
  if (value.type === "bookmark" && typeof value.saved === "boolean") return { ...position, type: value.type, saved: value.saved };
  return null;
}
function parseCache(raw: string | null): CachedLibrary {
  if (raw) try {
    const value: unknown = JSON.parse(raw);
    if (record(value) && Array.isArray(value.pending)) return {
      base: parseState(value.base),
      pending: value.pending.flatMap((item) => {
        if (!record(item) || typeof item.id !== "string") return [];
        const action = parseAction(item.action);
        const bookmark = parsePassage(item.bookmark);
        if (!action || (action.type === "bookmark" && action.saved && (!bookmark || bookmark.id !== passageId(action.bookId, action.editionId, action.chapterIndex, action.paragraphIndex)))) return [];
        return [{ id: item.id, action, ...(bookmark ? { bookmark } : {}) }];
      }),
    };
  } catch { /* A damaged browser cache must not prevent reading. */ }
  return { base: empty, pending: [] };
}
function applyAction(state: LibraryState, { action, bookmark }: QueuedAction): LibraryState {
  if (action.type === "save-book") return { ...state, savedIds: action.saved ? [...new Set([...state.savedIds, action.bookId])] : state.savedIds.filter((id) => id !== action.bookId) };
  if (action.type === "progress") return { ...state, progressByEdition: { ...state.progressByEdition, [locationKey(action.bookId, action.editionId)]: preciseProgress(action) }, lastReadBookId: action.bookId };
  const id = passageId(action.bookId, action.editionId, action.chapterIndex, action.paragraphIndex);
  const remaining = state.bookmarks.filter((passage) => passage.id !== id);
  return { ...state, bookmarks: action.saved && bookmark ? [...remaining, bookmark] : remaining };
}
const projectedState = (cache: CachedLibrary) => cache.pending.reduce(applyAction, cache.base);

export function ReadlayProvider({ children }: { children: ReactNode }) {
  return <SessionProvider><SessionLibrary>{children}</SessionLibrary></SessionProvider>;
}
function SessionLibrary({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const userId = status === "authenticated" && session?.user.id ? session.user.id : null;
  const identity = status === "loading" ? "loading" : userId ? `github:${userId}` : "guest";
  // Remount before rendering an account change so a previous account's data cannot flash.
  return <ReadlayStateProvider key={identity} userId={userId} sessionReady={status !== "loading"}>{children}</ReadlayStateProvider>;
}
function ReadlayStateProvider({ children, userId, sessionReady }: { children: ReactNode; userId: string | null; sessionReady: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<LibraryState>(empty);
  const [ready, setReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("local");
  const [toast, setToast] = useState("");
  const commands = useRef<{ enqueue: (create: (current: LibraryState) => QueuedAction | null) => void } | null>(null);

  useEffect(() => {
    if (!sessionReady) return;
    const key = `readlay-v4:${userId ? `github:${userId}` : "guest"}`;
    let mounted = true;
    let persistent = true;
    let cache: CachedLibrary = { base: empty, pending: [] };
    let localLock: Promise<unknown> = Promise.resolve();
    let syncing = false;
    let syncAgain = false;
    let needsPull = true;
    let migrationReady = false;
    const controller = new AbortController();

    async function prepareEditionCache() {
      let raw: string | null;
      try { raw = localStorage.getItem(key); if (raw === null && !userId) raw = localStorage.getItem("readlay-v3"); }
      catch { migrationReady = true; return; }
      const transitions = cachedRetiredEditions(raw, books);
      if (!raw || !transitions.length) { migrationReady = true; return; }
      const migrations: EditionMigration[] = [];
      for (const transition of transitions) {
        const params = `bookId=${encodeURIComponent(transition.bookId)}&from=${encodeURIComponent(transition.fromEditionId)}&to=${encodeURIComponent(transition.toEditionId)}`;
        const response = await request(`/api/edition-migrations?${params}`);
        const declared = response.headers.get("content-length");
        if (declared && Number(declared) > 4 * 1024 * 1024) throw new Error("Edition transition too large.");
        const body = await response.text();
        if (body.length > 4 * 1024 * 1024) throw new Error("Edition transition too large.");
        const migration = parseEditionMigration(JSON.parse(body));
        if (!migration || migration.bookId !== transition.bookId || migration.fromEditionId !== transition.fromEditionId || migration.toEditionId !== transition.toEditionId) throw new Error("Edition transition unavailable.");
        migrations.push(migration);
      }
      await cacheLock(() => {
        // Another tab may have saved since the request began. Project its latest cache.
        const latest = localStorage.getItem(key) ?? (!userId ? localStorage.getItem("readlay-v3") : null);
        if (latest) {
          for (const migration of migrations) {
            const archive = `${key}:edition-backup:${migration.bookId}:${migration.fromEditionId}:${migration.toEditionId}`;
            if (localStorage.getItem(archive) === null) localStorage.setItem(archive, latest);
          }
          const value: unknown = JSON.parse(latest);
          const migrated = migrateCachedLibrary(value, migrations);
          const wrapped = record(migrated) && Array.isArray(migrated.pending) ? migrated : { base: migrated, pending: [] };
          localStorage.setItem(key, JSON.stringify(wrapped));
        }
        migrationReady = true;
      });
    }

    function readCache() {
      try {
        const stored = localStorage.getItem(key);
        if (!userId && stored === null) {
          const legacy = localStorage.getItem("readlay-v3");
          cache = { base: legacy ? parseState(JSON.parse(legacy)) : empty, pending: [] };
          localStorage.setItem(key, JSON.stringify(cache));
        } else cache = parseCache(stored);
        persistent = true;
      } catch { persistent = false; }
      return cache;
    }
    function publish(next: CachedLibrary, persist = true) {
      cache = next;
      if (persist) try { localStorage.setItem(key, JSON.stringify(next)); persistent = true; } catch { persistent = false; }
      if (mounted) setState(projectedState(next));
    }
    async function cacheLock<T>(action: () => T | Promise<T>): Promise<T> {
      const run = () => { if (!mounted) throw new DOMException("Account changed", "AbortError"); return action(); };
      if (navigator.locks) return navigator.locks.request(`${key}:cache`, { signal: controller.signal }, run);
      const next = localLock.then(run, run);
      localLock = next.catch(() => {});
      return next;
    }
    async function request(path: string, init?: RequestInit) {
      const response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!response.ok) throw new Error(`Library request failed: ${response.status}`);
      return response;
    }
    async function pull() {
      const response = await request(`/api/library?expectedUserId=${encodeURIComponent(userId!)}`);
      const remote = parseState(await response.json());
      await cacheLock(() => { const current = readCache(); publish({ base: remote, pending: current.pending }); });
    }
    async function exchange() {
      if (!mounted) return;
      // The server snapshot is authoritative. Browser-only guest data is never imported.
      if (needsPull) { await pull(); needsPull = false; }
      let wrote = false;
      while (mounted) {
        const pending = await cacheLock(() => readCache().pending[0]);
        if (!pending) break;
        await request("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...pending.action, expectedUserId: userId }) });
        wrote = true;
        await cacheLock(() => {
          const current = readCache();
          publish({ base: applyAction(current.base, pending), pending: current.pending.filter((item) => item.id !== pending.id) });
        });
      }
      // Hydrate bookmarks from the server's book text and collect changes from other devices.
      if (wrote) await pull();
      if (mounted) {
        setSyncStatus(cache.pending.length ? "syncing" : persistent ? "synced" : "error");
        if (cache.pending.length) syncAgain = true;
      }
    }
    async function synchronise(refreshRemote = false) {
      if (!userId || !mounted) return;
      if (refreshRemote) needsPull = true;
      if (syncing) { syncAgain = true; return; }
      syncing = true;
      syncAgain = false;
      setSyncStatus("syncing");
      let succeeded = false;
      try {
        if (navigator.locks) await navigator.locks.request(`${key}:sync`, { signal: controller.signal }, exchange);
        else await exchange();
        succeeded = true;
      } catch {
        if (mounted) setSyncStatus("error");
      } finally {
        syncing = false;
        if (mounted) {
          setReady(true);
          if (succeeded && syncAgain) void synchronise();
        }
      }
    }
    commands.current = {
      enqueue(create) {
        if (!migrationReady) { setToast("Connect once to restore your place in the updated edition."); return; }
        void cacheLock(() => {
          const current = readCache();
          const entry = create(projectedState(current));
          if (!entry) return false;
          if (!userId) { publish({ base: applyAction(current.base, entry), pending: [] }); return false; }
          // Keep only the newest unsent reading position for this edition.
          const action = entry.action;
          const pending = action.type === "progress" ? current.pending.filter((item) => !(item.action.type === "progress" && item.action.bookId === action.bookId && item.action.editionId === action.editionId)) : current.pending;
          publish({ ...current, pending: [...pending, entry] });
          return true;
        }).then((changed) => { if (changed && mounted && userId) void synchronise(); }).catch(() => {});
      },
    };
    async function initialise() {
      await prepareEditionCache();
      await cacheLock(() => publish(readCache(), false));
      if (!mounted) return;
      if (userId) await synchronise();
      else setReady(true);
    }
    function receiveStorage(event: StorageEvent) {
      if (event.key !== key && event.key !== null) return;
      if (event.storageArea && event.storageArea !== localStorage) return;
      void cacheLock(() => publish(readCache(), false)).then(() => {
        if (mounted && userId) {
          if (cache.pending.length) void synchronise();
        }
      }).catch(() => {});
    }
    function refresh() {
      if (document.visibilityState !== "visible") return;
      if (!migrationReady) void initialise().catch(() => { if (mounted) { setReady(true); setSyncStatus("error"); } });
      else void synchronise(true);
    }
    window.addEventListener("storage", receiveStorage);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const retry = window.setInterval(() => { if (cache.pending.length && document.visibilityState === "visible") void synchronise(); }, 30_000);
    void initialise().catch(() => { if (mounted) { setReady(true); setSyncStatus("error"); } });
    return () => {
      mounted = false;
      controller.abort();
      commands.current = null;
      window.clearInterval(retry);
      window.removeEventListener("storage", receiveStorage);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [sessionReady, userId]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3000); return () => clearTimeout(timer); }, [toast]);

  function openAuth() {
    if (userId) { setToast("You are signed in with GitHub."); return; }
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const callbackUrl = current.startsWith("/") && !current.startsWith("//") && !current.includes("\\") && window.location.pathname !== "/sign-in" ? current : "/";
    router.push(`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  function toggleSaved(bookId: string) {
    if (!ready || !knownBook(bookId)) return;
    commands.current?.enqueue((current) => ({ id: crypto.randomUUID(), action: { type: "save-book", bookId, saved: !current.savedIds.includes(bookId) } }));
  }
  function getProgress(bookId: string, editionId = editionFor(bookId)) {
    return editionId ? state.progressByEdition[locationKey(bookId, editionId)] || null : null;
  }
  function saveProgress(chapterIndex: number, paragraphIndex: number, bookId: string, editionId: string, charOffset = 0) {
    if (!ready || !validLocation(bookId, editionId, { chapterIndex, paragraphIndex, charOffset })) return;
    const position = preciseProgress({ chapterIndex, paragraphIndex, charOffset });
    commands.current?.enqueue((current) => {
      const previous = current.progressByEdition[locationKey(bookId, editionId)];
      return previous?.chapterIndex === chapterIndex && previous.paragraphIndex === paragraphIndex && (previous.charOffset ?? 0) === charOffset && current.lastReadBookId === bookId ? null : { id: crypto.randomUUID(), action: { type: "progress", bookId, editionId, ...position } };
    });
  }
  function toggleBookmark(chapterIndex: number, paragraphIndex: number, text: string, bookId: string, editionId: string, chapterTitle = `Chapter ${chapterIndex + 1}`) {
    if (!ready || !validLocation(bookId, editionId, { chapterIndex, paragraphIndex })) return;
    const id = passageId(bookId, editionId, chapterIndex, paragraphIndex);
    commands.current?.enqueue((current) => ({ id: crypto.randomUUID(), action: { type: "bookmark", bookId, editionId, chapterIndex, paragraphIndex, saved: !current.bookmarks.some((passage) => passage.id === id) }, bookmark: { id, bookId, editionId, chapterIndex, paragraphIndex, text, chapterTitle } }));
  }
  return <ReadlayContext.Provider value={{ ...state, ready, isSignedIn: !!userId, syncStatus, toggleSaved, getProgress, saveProgress, toggleBookmark, openAuth, notify: setToast }}>
    {children}
    <div className={`toast ${toast ? "is-visible" : ""}`} role="status">{toast}</div>
  </ReadlayContext.Provider>;
}
export function useReadlay() {
  const context = useContext(ReadlayContext);
  if (!context) throw new Error("ReadlayProvider is required");
  return context;
}
