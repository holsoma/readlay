import { auth, authConfigured } from "@/auth";
import { AudioError, getAudioManifest, listNarrators } from "@/lib/audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const session = authConfigured ? await auth() : null;
    if (!session?.user?.id) throw new AudioError(401, "Sign in to listen.");
    const { bookId } = await params;
    const narrator = new URL(request.url).searchParams.get("narrator");
    const body = narrator === null ? { narrators: await listNarrators(bookId) } : await getAudioManifest(bookId, narrator);
    return Response.json(body, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof AudioError ? error.message : "Audio is temporarily unavailable." },
      { status: error instanceof AudioError ? error.status : 503, headers });
  }
}
