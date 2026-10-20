#!/usr/bin/env node

// Server-only storage setup for holsoma/readlay. Values never enter argv or logs.
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const PROJECT_REF = "tgxmdccqlbyevpjhthxv";
export const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
export const VARIABLE_NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AUDIO_STORAGE_BUCKET", "AUDIO_STORAGE_MODE"];
const defaults = { SUPABASE_URL: PROJECT_URL, AUDIO_STORAGE_BUCKET: "readlay-audio", AUDIO_STORAGE_MODE: "supabase" };

export function initialEnvironmentText(source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const found = new Set();
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    if (!match || !VARIABLE_NAMES.includes(match[1])) continue;
    if (found.has(match[1])) throw new Error("A storage variable occurs more than once in .env.local. Remove the duplicate before initialising.");
    found.add(match[1]);
    if (Object.hasOwn(defaults, match[1])) lines[index] = `${match[1]}=${defaults[match[1]]}`;
    // Existing secret values remain byte-for-byte unchanged.
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const name of VARIABLE_NAMES) {
    if (found.has(name)) continue;
    if (name === "SUPABASE_SERVICE_ROLE_KEY") lines.push("# Server-only Supabase sb_secret_ key, or a legacy service_role JWT.");
    lines.push(`${name}=${defaults[name] || ""}`);
  }
  return lines.join(newline) + newline;
}

export async function initialiseLocalEnvironment(file = path.join(root, ".env.local")) {
  let source = "";
  try { source = await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const target = initialEnvironmentText(source);
  const temporary = `${file}.readlay-storage-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, target, { encoding: "utf8", mode: 0o600, flag: "wx" });
    let current = "";
    try { current = await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current !== source) throw new Error("The local environment file changed during setup. Existing edits were preserved; retry initialisation.");
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function validatedValues(environment = process.env) {
  const values = Object.fromEntries(VARIABLE_NAMES.map((name) => [name, environment[name]?.trim() || ""]));
  if (values.SUPABASE_URL !== PROJECT_URL || values.AUDIO_STORAGE_BUCKET !== defaults.AUDIO_STORAGE_BUCKET || values.AUDIO_STORAGE_MODE !== "supabase") {
    throw new Error("Storage must target the approved Readlay project, readlay-audio bucket and supabase mode. Run --initialise first.");
  }
  const key = values.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Add the server-only Supabase secret key to SUPABASE_SERVICE_ROLE_KEY in .env.local. No Vercel changes were made.");
  if (key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error("The server-only Supabase key contains invalid characters. No Vercel changes were made.");
  if (!/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(key)) {
    try {
      const parts = key.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload.role !== "service_role" || payload.ref !== PROJECT_REF) throw new Error();
    } catch { throw new Error("Use a server-only sb_secret_ key or the approved project's legacy service_role JWT. Publishable and anon keys cannot upload private audio."); }
  }
  return values;
}

export function vercelArguments(name) {
  if (!VARIABLE_NAMES.includes(name)) throw new Error("Only Readlay's four storage variables may be uploaded.");
  return ["--yes", "vercel@latest", "env", "add", name, "--environment", "production,preview", "--sensitive", "--yes", "--force", "--scope", "holsoma"];
}

export function uploadVariable(name, value, spawnProcess = spawn, environment = process.env) {
  const args = vercelArguments(name);
  const windows = process.platform === "win32";
  const executable = windows ? environment.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "npx";
  const commandArgs = windows ? ["/d", "/s", "/c", ["npx.cmd", ...args].join(" ")] : args;
  const childEnvironment = { ...environment, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" };
  for (const key of Object.keys(childEnvironment)) {
    if (/^(AUTH_|DATABASE_URL$|POSTGRES_|SUPABASE_|AUDIO_)/.test(key)) delete childEnvironment[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, commandArgs, { cwd: root, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let inputFailed = false;
    // Discard CLI output rather than attempting to enumerate every possible
    // encoding of a secret. Only a fixed success/failure message is displayed.
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => { inputFailed = true; });
    child.on("error", () => reject(new Error(`${name} could not be uploaded. Check the Vercel sign-in and retry.`)));
    child.on("close", (code) => code === 0 && !inputFailed ? resolve() : reject(new Error(`${name} was not confirmed. Check the Vercel sign-in and retry.`)));
    child.stdin.end(`${value}\n`);
  });
}

async function verifyVercelProject() {
  let project;
  try { project = JSON.parse(await readFile(path.join(root, ".vercel", "project.json"), "utf8")); }
  catch { throw new Error("Link the workspace to the existing holsoma/readlay Vercel project first. No Vercel changes were made."); }
  if (project.projectName !== "readlay" || project.projectId !== "prj_8q0BAGbufA0TTsLstL8LkmK9wFjU" || project.orgId !== "team_Wmt30x1aiIAIFLHGzoYq11OK") {
    throw new Error("The linked Vercel project does not match the approved holsoma/readlay project. No Vercel changes were made.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && !["--check", "--initialise", "--help"].includes(args[0])) throw new Error("Usage: node --env-file-if-exists=.env.local scripts/audio/configure_storage.mjs [--check|--initialise]");
  if (args[0] === "--help") {
    console.log("Initialise non-secret local Readlay storage settings with --initialise. Add a server-only key to .env.local, then use --check or upload the four storage variables to production and preview. Values are sent through stdin and never printed. No deployment runs.");
    return;
  }
  if (args[0] === "--initialise") {
    await initialiseLocalEnvironment();
    console.log("Readlay storage settings initialised in ignored .env.local. Existing secret values were preserved. No Vercel changes were made.");
    return;
  }
  const values = validatedValues();
  await verifyVercelProject();
  if (args[0] === "--check") {
    console.log("Readlay's four storage settings are present and the Vercel project matches. No values printed and no Vercel changes made.");
    return;
  }
  for (const name of VARIABLE_NAMES) {
    console.log(`Uploading ${name} to holsoma/readlay for production and preview.`);
    await uploadVariable(name, values[name]);
  }
  console.log("Storage settings uploaded. Existing auth and database variables were not changed. Redeploy separately to apply them.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Storage setup was not completed. Check the local settings and Vercel sign-in, then retry. No credential values were printed."); process.exitCode = 1; });
}
