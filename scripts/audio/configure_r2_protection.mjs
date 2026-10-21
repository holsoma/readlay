import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { verifyVercelProject } from "./configure_r2.mjs";

const root = path.resolve(import.meta.dirname, "../..");
export const names = ["CLOUDFLARE_R2_ANALYTICS_TOKEN", "READLAY_ADMIN_GITHUB_IDS", "CRON_SECRET"];
export function prepareEnvironment(text, adminId, secret = () => randomBytes(32).toString("base64url")) {
  if (!/^\d{1,30}$/.test(adminId || "")) throw Error("Supply the administrator's stable GitHub ID.");
  const present = parseEnv(text), lines = text.trimEnd().split(/\r?\n/);
  for (const name of names) if (!Object.hasOwn(present, name)) {
    lines.push(`${name}=${name === "READLAY_ADMIN_GITHUB_IDS" ? adminId : name === "CRON_SECRET" ? secret() : ""}`);
  }
  return lines.join("\n") + "\n";
}
export function validateEnvironment(value) {
  const values = Object.fromEntries(names.map(name => [name, value[name]?.trim() || ""]));
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(values.CLOUDFLARE_R2_ANALYTICS_TOKEN)) throw Error("Add the read-only Analytics token to CLOUDFLARE_R2_ANALYTICS_TOKEN.");
  validateAdminAndCron(values);
  return values;
}
export function validateAdminAndCron(values) {
  if (!/^\d{1,30}(?:\s*,\s*\d{1,30})*$/.test(values.READLAY_ADMIN_GITHUB_IDS)) throw Error("Set READLAY_ADMIN_GITHUB_IDS to stable numeric GitHub IDs.");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(values.CRON_SECRET)) throw Error("Set CRON_SECRET to a random server-only secret of at least 32 characters.");
}
export function vercelArguments(name) {
  if (!names.includes(name)) throw Error("Only the three R2 protection fields may be uploaded.");
  return ["--yes", "vercel@65.0.0", "env", "add", name, "--environment", "production", "--sensitive", "--yes", "--force", "--scope", "holsoma"];
}
export function uploadVariable(name, value) {
  const args = vercelArguments(name), windows = process.platform === "win32";
  const executable = windows ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "npx";
  const command = windows ? ["/d", "/s", "/c", ["npx.cmd", ...args].join(" ")] : args;
  const env = { ...process.env, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" };
  for (const key of Object.keys(env)) if (/^(?:AUTH_|DATABASE_URL|POSTGRES_|SUPABASE_|AUDIO_|R2_|CF_|CLOUDFLARE_|READLAY_ADMIN_|CRON_SECRET)/.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, command, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let failed = false;
    child.stdout.resume(); child.stderr.resume(); child.stdin.on("error", () => { failed = true; });
    child.on("error", () => reject(Error(`${name} could not be uploaded.`)));
    child.on("close", code => code === 0 && !failed ? resolve() : reject(Error(`${name} was not confirmed by Vercel.`)));
    child.stdin.end(value + "\n");
  });
}
async function main() {
  const args = process.argv.slice(2), file = path.join(root, ".env.local");
  if (args[0] === "--initialise" && args[1] === "--admin-id" && args.length === 3) {
    await writeFile(file, prepareEnvironment(await readFile(file, "utf8"), args[2]));
    console.log("R2 protection fields prepared in ignored .env.local. Existing values were kept. No Vercel changes made."); return;
  }
  if (args.length !== 1 || !["--check", "--upload", "--upload-paused"].includes(args[0])) throw Error("Use --initialise --admin-id <GitHub ID>, --check, --upload or --upload-paused.");
  const parsed = parseEnv(await readFile(file, "utf8"));
  const paused = args[0] === "--upload-paused";
  const values = paused ? Object.fromEntries(names.filter(name => name !== "CLOUDFLARE_R2_ANALYTICS_TOKEN").map(name => [name, parsed[name]?.trim() || ""])) : validateEnvironment(parsed);
  if (paused) validateAdminAndCron(values);
  await verifyVercelProject();
  if (args[0] === "--check") { console.log("The three R2 protection fields and the existing Vercel project are valid. Values were not printed."); return; }
  for (const name of Object.keys(values)) { await uploadVariable(name, values[name]); console.log(`${name} stored securely in Readlay production.`); }
  if (paused) console.log("Analytics was not configured. The deployed guard will block R2 requests until real usage is verified.");
  console.log("No unrelated credentials were retrieved or changed. Redeploy separately to apply these fields.");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
