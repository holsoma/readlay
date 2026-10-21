import "server-only";
import { GetObjectCommand, HeadObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { r2Client } from "./r2-client";
import { R2QuotaError, r2Identity, reserveR2Operation } from "./r2-quota";
import type { AudioStorageDestination } from "./audio-storage";

const audioObject = /^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/){4}chapter-\d{4,6}\.(?:mp3|opus)$/;
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes" };
export function validAudioRange(range: string | null): boolean {
  if (range === null) return true;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return false;
  if ([match[1], match[2]].filter(Boolean).some(n => !Number.isSafeInteger(Number(n)))) return false;
  return match[1] ? !match[2] || Number(match[1]) <= Number(match[2]) : Number(match[2]) > 0;
}

/** Every GET, range GET and HEAD is authorised and reserved before reaching R2. */
export async function streamR2Audio(request: Request, subject: string, destination: AudioStorageDestination, audioPath: string, byteLength?: number): Promise<Response> {
  const { account, bucket } = r2Identity();
  if (destination.provider !== "r2" || destination.bucket !== bucket || destination.origin !== `https://${account}.r2.cloudflarestorage.com` || !audioObject.test(audioPath)) throw new R2QuotaError(503, "This audio location is unavailable.");
  const range = request.headers.get("range");
  if (!validAudioRange(range)) return new Response(null, { status: 416, headers: { ...headers, ...(byteLength ? { "Content-Range": `bytes */${byteLength}` } : {}) } });
  const head = request.method === "HEAD";
  await reserveR2Operation(head ? "HeadObject" : "GetObject", subject);
  const client = r2Client();
  try {
    const input = { Bucket: bucket, Key: audioPath, ...(range && !head ? { Range: range } : {}) };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
    const result = await client.send(head ? new HeadObjectCommand(input) : new GetObjectCommand(input), { abortSignal: signal });
    if (typeof result.ContentLength !== "number" || !Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0) throw new Error("Invalid audio length");
    const contentRange = result.ContentRange;
    if (contentRange && !/^bytes \d+-\d+\/\d+$/.test(contentRange)) throw new Error("Invalid audio range");
    if (!head && range && !contentRange) throw new Error("The audio range was not honoured");
    const responseHeaders = { ...headers, "Content-Type": audioPath.endsWith(".opus") ? "audio/ogg" : "audio/mpeg", "Content-Length": String(result.ContentLength),
      ...(contentRange ? { "Content-Range": contentRange } : {}) };
    if (head) { client.destroy(); return new Response(null, { status: 200, headers: responseHeaders }); }
    const body = (result as GetObjectCommandOutput).Body;
    if (!body) throw new Error("No audio body");
    const reader = body.transformToWebStream().getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { client.destroy(); controller.close(); }
          else controller.enqueue(next.value);
        } catch { client.destroy(); controller.error(new Error("Audio connection interrupted. Try again.")); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { client.destroy(); } },
    });
    return new Response(stream, { status: contentRange ? 206 : 200, headers: responseHeaders });
  } catch (error) {
    client.destroy();
    const status = error && typeof error === "object" && "$metadata" in error && error.$metadata && typeof error.$metadata === "object" && "httpStatusCode" in error.$metadata ? error.$metadata.httpStatusCode : null;
    if (status === 416) return new Response(null, { status: 416, headers: { ...headers, ...(byteLength ? { "Content-Range": `bytes */${byteLength}` } : {}) } });
    throw new R2QuotaError(503, "The audiobook could not be streamed. Its quota reservation was kept because the request may have reached R2.");
  }
}
