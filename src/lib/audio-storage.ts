import "server-only";

export type AudioStorageProvider = "supabase" | "r2";
export type AudioStorageDestination = { provider: AudioStorageProvider; origin: string; bucket: string };
export class AudioStorageError extends Error {}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const audioObject = /^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/){4}chapter-\d{4,6}\.(?:mp3|opus)$/;

export function audioStorageDestination(provider: AudioStorageProvider): AudioStorageDestination {
  if (provider === "r2") {
    const account = process.env.R2_ACCOUNT_ID?.trim();
    const bucket = process.env.R2_AUDIO_BUCKET?.trim() || "readlay-audio";
    if (!account || !/^[a-f0-9]{32}$/i.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new AudioStorageError("Audio storage is not configured.");
    return { provider, origin: `https://${account.toLowerCase()}.r2.cloudflarestorage.com`, bucket };
  }
  const projectUrl = process.env.SUPABASE_URL?.trim();
  const bucket = process.env.AUDIO_STORAGE_BUCKET?.trim() || "readlay-audio";
  if (!projectUrl || !safeId.test(bucket)) throw new AudioStorageError("Audio storage is not configured.");
  let base: URL;
  try { base = new URL(projectUrl); } catch { throw new AudioStorageError("Audio storage is not configured."); }
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new AudioStorageError("Audio storage is not configured.");
  return { provider, origin: base.origin, bucket };
}

/** The publication receipt chooses the backend, rather than the current default. */
export function publicationStorageDestination(value: unknown): AudioStorageDestination | null {
  if (!value || typeof value !== "object") return null;
  const publication = value as Record<string, unknown>;
  const provider = publication.storageProvider === undefined ? "supabase" : publication.storageProvider;
  if (provider !== "supabase" && provider !== "r2") return null;
  try {
    const destination = audioStorageDestination(provider);
    return publication.storageOrigin === destination.origin && publication.bucket === destination.bucket ? destination : null;
  } catch { return null; }
}

export async function createSignedAudioUrl(destination: AudioStorageDestination, audioPath: string, durationSeconds: number): Promise<string> {
  if (!audioObject.test(audioPath) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new AudioStorageError("The audio file could not be opened.");
  const configured = audioStorageDestination(destination.provider);
  if (configured.origin !== destination.origin || configured.bucket !== destination.bucket) throw new AudioStorageError("Audio storage is not configured.");
  const expiresIn = Math.min(86400, Math.max(3600, Math.ceil(durationSeconds / 0.75) + 900));
  if (destination.provider === "r2") {
    throw new AudioStorageError("R2 playback must use the authenticated, quota-checked stream.");
  }
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!secret) throw new AudioStorageError("Audio storage is not configured.");
  const objectPath = `${encodeURIComponent(destination.bucket)}/${audioPath.split("/").map(encodeURIComponent).join("/")}`;
  const headers: Record<string, string> = { apikey: secret, "Content-Type": "application/json" };
  if (!secret.startsWith("sb_secret_")) headers.Authorization = `Bearer ${secret}`;
  const response = await fetch(new URL(`/storage/v1/object/sign/${objectPath}`, destination.origin), {
    method: "POST", headers, body: JSON.stringify({ expiresIn }), cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new AudioStorageError("The audio file could not be opened. Try again.");
  const result: unknown = await response.json();
  const signed = result && typeof result === "object" && "signedURL" in result ? result.signedURL : null;
  if (typeof signed !== "string") throw new AudioStorageError("The audio file could not be opened.");
  const target = new URL(signed.startsWith("/object/") ? `/storage/v1${signed}` : signed, destination.origin);
  if (target.origin !== destination.origin || target.pathname !== `/storage/v1/object/sign/${objectPath}` || !target.searchParams.get("token")) throw new AudioStorageError("The audio file could not be opened.");
  return target.href;
}
