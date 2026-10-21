"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSession } from "next-auth/react";
import { parseWordBank, type SavedWord, type SaveWordInput, type WordBankAction, type WordStatus } from "@/lib/wordbank-types";

type WordBankContextValue = {
  words: SavedWord[];
  ready: boolean;
  isSignedIn: boolean;
  error: string | null;
  saveWord: (input: SaveWordInput) => Promise<SavedWord>;
  removeWord: (id: string) => Promise<void>;
  setWordStatus: (id: string, status: WordStatus) => Promise<void>;
  refresh: () => Promise<void>;
};
const WordBankContext = createContext<WordBankContextValue | null>(null);

export function WordBankProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const userId = status === "authenticated" && session?.user.id ? session.user.id : null;
  const identity = status === "loading" ? "loading" : userId ? `github:${userId}` : "guest";
  return <AccountWordBank key={identity} userId={userId} sessionReady={status !== "loading"}>{children}</AccountWordBank>;
}

function AccountWordBank({ children, userId, sessionReady }: { children: ReactNode; userId: string | null; sessionReady: boolean }) {
  const [words, setWords] = useState<SavedWord[]>([]);
  const [ready, setReady] = useState(sessionReady && !userId);
  const [error, setError] = useState<string | null>(null);
  const commands = useRef<{ request: (action?: WordBankAction) => Promise<SavedWord[]> } | null>(null);

  useEffect(() => {
    if (!sessionReady) return;
    let mounted = true;
    const controller = new AbortController();
    let queue: Promise<unknown> = Promise.resolve();
    const invalidationKey = userId ? `readlay-word-bank:${userId}:invalidate` : null;
    const channel = userId && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(`readlay-word-bank:${userId}`) : null;

    function invalidateOtherTabs() {
      channel?.postMessage({ changed: true });
      // Only an invalidation marker is persisted, never definitions or source book text.
      if (invalidationKey) try { localStorage.setItem(invalidationKey, crypto.randomUUID()); } catch { /* Storage can be unavailable in private browsing. */ }
    }
    async function exchange(action?: WordBankAction): Promise<SavedWord[]> {
      if (!mounted) throw new DOMException("Account changed", "AbortError");
      if (!userId) throw new Error("Sign in with GitHub to save vocabulary.");
      try {
        const response = await fetch(action ? "/api/word-bank" : `/api/word-bank?expectedUserId=${encodeURIComponent(userId)}`, {
          method: action ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
          ...(action ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...action, expectedUserId: userId }) } : {}),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        const body: unknown = await response.json();
        if (!response.ok) {
          const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Your Word Bank could not be updated. Try again.";
          throw new Error(message);
        }
        const next = parseWordBank(body);
        if (!next) throw new Error("Your Word Bank could not be loaded. Try again.");
        if (!mounted) throw new DOMException("Account changed", "AbortError");
        setWords(next);
        setError(null);
        if (action) invalidateOtherTabs();
        return next;
      } catch (failure) {
        if (mounted) setError(failure instanceof Error ? failure.message : "Your Word Bank could not be updated. Try again.");
        throw failure;
      } finally { if (mounted) setReady(true); }
    }
    function request(action?: WordBankAction) {
      // Serialise pulls and writes so a late refresh cannot replace a completed save.
      const next = queue.then(() => exchange(action), () => exchange(action));
      queue = next.catch(() => {});
      return next;
    }
    commands.current = { request };
    function refresh() { if (userId && document.visibilityState === "visible") void request().catch(() => {}); }
    function receiveStorage(event: StorageEvent) { if (event.key === invalidationKey) refresh(); }
    if (channel) channel.onmessage = refresh;
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("storage", receiveStorage);
    document.addEventListener("visibilitychange", refresh);
    if (userId) void request().catch(() => {});
    return () => {
      mounted = false;
      controller.abort();
      commands.current = null;
      channel?.close();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("storage", receiveStorage);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [userId, sessionReady]);

  async function request(action?: WordBankAction) {
    if (!userId) throw new Error("Sign in with GitHub to save vocabulary.");
    if (!commands.current) throw new Error("Your Word Bank is still loading. Try again.");
    return commands.current.request(action);
  }
  async function saveWord(input: SaveWordInput) {
    const next = await request({ action: "save", ...input });
    const saved = next.find((word) => (!input.entry || word.word === input.entry.word) && word.occurrences.some((occurrence) => occurrence.bookId === input.bookId && occurrence.editionId === input.editionId &&
      occurrence.chapterIndex === input.chapterIndex && occurrence.paragraphIndex === input.paragraphIndex && occurrence.charStart === input.charStart && occurrence.charEnd === input.charEnd));
    if (!saved) throw new Error("The word was not found after saving. Try again.");
    return saved;
  }
  return <WordBankContext.Provider value={{
    words, ready, isSignedIn: !!userId, error, saveWord,
    removeWord: async (id) => { await request({ action: "remove", id }); },
    setWordStatus: async (id, status) => { await request({ action: "status", id, status }); },
    refresh: async () => { await request(); },
  }}>{children}</WordBankContext.Provider>;
}

export function useWordBank() {
  const context = useContext(WordBankContext);
  if (!context) throw new Error("WordBankProvider is required");
  return context;
}
