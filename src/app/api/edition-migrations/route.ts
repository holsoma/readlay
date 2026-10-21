import { getEditionMigrations, maximumMigrationBytes } from "@/lib/edition-migration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "X-Content-Type-Options": "nosniff" };

// This contains numbers and edition identifiers only, with no source text or account data.
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    const migration = (await getEditionMigrations()).find((item) => item.bookId === query.get("bookId") && item.fromEditionId === query.get("from") && item.toEditionId === query.get("to"));
    if (!migration) return Response.json({ error: "Edition transition not found." }, { status: 404, headers: { ...headers, "Cache-Control": "no-store" } });
    const body = JSON.stringify(migration);
    if (Buffer.byteLength(body, "utf8") > maximumMigrationBytes) throw new Error("Edition transition too large.");
    return new Response(body, { headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch {
    return Response.json({ error: "The edition transition is unavailable. Try again." }, { status: 503, headers: { ...headers, "Cache-Control": "no-store" } });
  }
}
