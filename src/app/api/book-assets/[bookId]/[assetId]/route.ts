import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { auth, authConfigured } from "@/auth";
import { getBookContent } from "@/lib/book-content";
import { getReaderPresentation } from "@/lib/reader-presentation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };

export async function GET(_request: Request, { params }: { params: Promise<{ bookId: string; assetId: string }> }) {
  const session = authConfigured ? await auth() : null;
  if (!session?.user?.id) return new Response("Sign in to view book illustrations.", { status: 401, headers });
  const { bookId, assetId } = await params;
  if (!/^[a-f0-9]{16,64}$/u.test(assetId)) return new Response("Image not found.", { status: 404, headers });
  const content = await getBookContent(bookId);
  const presentation = content && await getReaderPresentation(bookId, content.editionId, content.chapters);
  const image = presentation?.chapters.flatMap((chapter) => chapter.images).find((item) => item.id === assetId);
  if (!image) return new Response("Image not found.", { status: 404, headers });
  try {
    const filename = path.join(process.cwd(), ".local", "book-assets", bookId, image.filename);
    const info = await stat(filename);
    if (!info.isFile() || info.size > 12 * 1024 * 1024) return new Response("Image unavailable.", { status: 404, headers });
    const bytes = await readFile(filename);
    return new Response(bytes, { headers: { ...headers, "Cache-Control": "private, max-age=3600", "Content-Type": image.mediaType, "Content-Length": String(bytes.byteLength), "Content-Disposition": `inline; filename="${image.filename}"` } });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Response("Image not found.", { status: 404, headers });
    return new Response("Image unavailable.", { status: 503, headers });
  }
}
