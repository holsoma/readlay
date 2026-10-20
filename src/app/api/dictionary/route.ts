import { auth, authConfigured } from "@/auth";
import { DictionaryError, getDictionaryLookup } from "@/lib/dictionary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });

export async function GET(request: Request): Promise<Response> {
  try {
    if (!authConfigured || !(await auth())?.user?.id) return json({ error: "Sign in with GitHub to use the dictionary." }, 401);
    const words = new URL(request.url).searchParams.getAll("word");
    if (words.length !== 1) throw new DictionaryError(400, "Select one English word to look it up.");
    return json(await getDictionaryLookup(words[0]));
  } catch (error) {
    return error instanceof DictionaryError ? json({ error: error.message }, error.status)
      : json({ error: "The dictionary is unavailable. Try again shortly." }, 503);
  }
}
