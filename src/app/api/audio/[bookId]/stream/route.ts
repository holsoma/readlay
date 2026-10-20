import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth, authConfigured } from "@/auth";
import { AudioError, getAudioManifest, localAudioFile, signedAudioUrl } from "@/lib/audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

export async function GET(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  try {
    const session = authConfigured ? await auth() : null;
    if (!session?.user?.id) throw new AudioError(401, "Sign in to listen.");
    const { bookId } = await params;
    const query = new URL(request.url).searchParams;
    const narrator = query.get("narrator");
    const chapterValue = query.get("chapter");
    if (!narrator || !chapterValue || !/^\d{1,5}$/.test(chapterValue)) throw new AudioError(400, "Choose a chapter and narrator.");
    const manifest = await getAudioManifest(bookId, narrator);
    if (query.has("v") && query.get("v") !== manifest.generationId) throw new AudioError(404, "This narration has changed. Open it again.");
    const chapter = manifest.chapters.find(item => item.chapterIndex === Number(chapterValue));
    if (!chapter) throw new AudioError(404, "This chapter has no narration yet.");
    const local = localAudioFile(chapter.audioPath);
    if (local) {
      const { size } = await stat(local);
      const range = request.headers.get("range");
      let start = 0;
      let end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      }
      const stream = Readable.toWeb(createReadStream(local, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(stream, { status: range ? 206 : 200, headers: {
        ...headers, "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      } });
    }
    const url = await signedAudioUrl(chapter.audioPath, chapter.durationSeconds);
    return new Response(null, { status: 307, headers: { ...headers, Location: url } });
  } catch (error) {
    return Response.json({ error: error instanceof AudioError ? error.message : "Audio is temporarily unavailable." },
      { status: error instanceof AudioError ? error.status : 503, headers });
  }
}
