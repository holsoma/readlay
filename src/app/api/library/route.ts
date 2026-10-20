import { auth, authConfigured } from "@/auth";
import { applyLibraryAction, getLibraryState, LibraryError, parseLibraryAction } from "@/lib/library-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maximumBodyBytes = 16 * 1024;
const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
}

async function authenticatedUserId(): Promise<string> {
  if (!authConfigured) throw new LibraryError(401, "Sign in with GitHub to synchronise your library.");
  const session = await auth();
  if (!session?.user?.id) throw new LibraryError(401, "Sign in with GitHub to synchronise your library.");
  return session.user.id;
}

function errorResponse(error: unknown): Response {
  return error instanceof LibraryError
    ? json({ error: error.message }, error.status)
    : json({ error: "The library could not be updated. Try again." }, 500);
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new LibraryError(400, "Send a JSON library action.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBodyBytes)) {
    throw new LibraryError(400, "The library action is too large.");
  }
  if (!request.body) throw new LibraryError(400, "Send a JSON library action.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBodyBytes) {
        await reader.cancel();
        throw new LibraryError(400, "The library action is too large.");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    throw new LibraryError(400, "Send a valid JSON library action.");
  } finally {
    reader.releaseLock();
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const userId = await authenticatedUserId();
    const expectedUserId = new URL(request.url).searchParams.get("expectedUserId");
    if (expectedUserId !== null && expectedUserId !== userId) {
      throw new LibraryError(401, "Your GitHub session changed.");
    }
    return json(await getLibraryState(userId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const userId = await authenticatedUserId();
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      throw new LibraryError(400, "Invalid request origin.");
    }
    const action = parseLibraryAction(await readJson(request));
    if (action.expectedUserId !== userId) throw new LibraryError(401, "Your GitHub session changed.");
    await applyLibraryAction(userId, action);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
