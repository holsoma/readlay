import { auth, authConfigured } from "@/auth";
import { AudioError, getAudioManifest, listNarrators } from "@/lib/audio-store";
import { audioManifestIndex } from "@/lib/audio-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const session = authConfigured ? await auth() : null;
    if (!session?.user?.id) throw new AudioError(401, "Sign in to listen.");
    const { bookId } = await params;
    const query = new URL(request.url).searchParams;
    const narrator = query.get("narrator");
    if (narrator === null) return Response.json({ narrators: await listNarrators(bookId) }, { headers });
    const manifest = await getAudioManifest(bookId, narrator);
    if (query.has("v") && query.get("v") !== manifest.generationId) throw new AudioError(404, "This narration has changed. Open it again.");
    const chapterValue = query.get("chapter");
    let body: unknown = query.get("index") === "1" ? audioManifestIndex(manifest) : manifest;
    if (chapterValue !== null) {
      if (!/^\d{1,5}$/.test(chapterValue)) throw new AudioError(400, "Choose a chapter.");
      body = manifest.chapters.find(chapter => chapter.chapterIndex === Number(chapterValue));
      if (!body) throw new AudioError(404, "This chapter has no narration yet.");
    }
    return Response.json(body, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof AudioError ? error.message : "Audio is temporarily unavailable." },
      { status: error instanceof AudioError ? error.status : 503, headers });
  }
}
