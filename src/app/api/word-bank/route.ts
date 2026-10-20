import { auth, authConfigured } from "@/auth";
import { applyWordBankAction, getWordBank, parseWordBankAction, WordBankError } from "@/lib/wordbank-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const maximumBodyBytes = 4 * 1024;
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });

async function authenticatedUserId() {
  if (!authConfigured) throw new WordBankError(401, "Sign in with GitHub to use your Word Bank.");
  const session = await auth();
  if (!session?.user?.id) throw new WordBankError(401, "Sign in with GitHub to use your Word Bank.");
  return session.user.id;
}
function errorResponse(error: unknown) {
  return error instanceof WordBankError ? json({ error: error.message }, error.status)
    : json({ error: "Your Word Bank could not be updated. Try again." }, 500);
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new WordBankError(400, "Send a JSON Word Bank action.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBodyBytes)) {
    throw new WordBankError(400, "The Word Bank action is too large.");
  }
  if (!request.body) throw new WordBankError(400, "Send a JSON Word Bank action.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBodyBytes) { await reader.cancel(); throw new WordBankError(400, "The Word Bank action is too large."); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof WordBankError) throw error;
    throw new WordBankError(400, "Send a valid JSON Word Bank action.");
  } finally { reader.releaseLock(); }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const userId = await authenticatedUserId();
    const expected = new URL(request.url).searchParams.get("expectedUserId");
    if (expected !== null && expected !== userId) throw new WordBankError(401, "Your GitHub session changed.");
    return json({ words: await getWordBank(userId) });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const userId = await authenticatedUserId();
    if (request.headers.get("origin") !== new URL(request.url).origin) throw new WordBankError(400, "Invalid request origin.");
    const action = parseWordBankAction(await readJson(request));
    if (action.expectedUserId !== userId) throw new WordBankError(401, "Your GitHub session changed.");
    await applyWordBankAction(userId, action);
    return json({ words: await getWordBank(userId) });
  } catch (error) { return errorResponse(error); }
}
