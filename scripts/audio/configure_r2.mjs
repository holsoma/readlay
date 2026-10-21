#!/usr/bin/env node

// Server-only R2 setup for the existing holsoma/readlay Vercel project.
// Credential values use stdin only and never enter command arguments or logs.
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const VARIABLE_NAMES = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_AUDIO_BUCKET", "AUDIO_STORAGE_MODE"];
const defaults = { R2_AUDIO_BUCKET: "readlay-audio", AUDIO_STORAGE_MODE: "supabase" };

export function initialEnvironmentText(source) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const found = new Set();
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    if (!match || !VARIABLE_NAMES.includes(match[1])) continue;
    if (found.has(match[1])) throw new Error("An R2 variable occurs more than once in .env.local. Remove the duplicate before initialising.");
    found.add(match[1]);
    if (match[1] === "R2_AUDIO_BUCKET") lines[index] = `${match[1]}=${defaults[match[1]]}`;
    // Existing account and credential lines remain byte-for-byte unchanged.
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  for (const name of VARIABLE_NAMES) {
    if (found.has(name)) continue;
    if (name === "R2_ACCESS_KEY_ID") lines.push("# Server-only R2 S3 credentials for the private readlay-audio bucket.");
    lines.push(`${name}=${defaults[name] || ""}`);
  }
  return lines.join(newline) + newline;
}

export async function initialiseLocalEnvironment(file = path.join(root, ".env.local")) {
  let source = "";
  try { source = await readFile(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const target = initialEnvironmentText(source);
  const temporary = `${file}.readlay-r2-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, target, { encoding: "utf8", mode: 0o600, flag: "wx" });
    let current = "";
    try { current = await readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current !== source) throw new Error("The local environment file changed during R2 setup. Existing edits were preserved; retry initialisation.");
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

export function validatedValues(environment = process.env) {
  const values = Object.fromEntries(VARIABLE_NAMES.map((name) => [name, environment[name]?.trim() || ""]));
  if (!/^[a-f0-9]{32}$/i.test(values.R2_ACCOUNT_ID)) throw new Error("Add the 32-character R2 account identifier to R2_ACCOUNT_ID. No Vercel changes were made.");
  if (!/^[a-f0-9]{32}$/i.test(values.R2_ACCESS_KEY_ID) || !/^[a-f0-9]{64}$/i.test(values.R2_SECRET_ACCESS_KEY)) {
    throw new Error("Add the server-only R2 S3 access key and secret to the existing fields. No Vercel changes were made.");
  }
  if (values.R2_AUDIO_BUCKET !== defaults.R2_AUDIO_BUCKET || !["supabase", "r2"].includes(values.AUDIO_STORAGE_MODE)) {
    throw new Error("Use the approved private readlay-audio bucket and a supabase or r2 server mode. Existing playback can remain on Supabase.");
  }
  return values;
}

export function vercelArguments(name) {
  if (!VARIABLE_NAMES.includes(name)) throw new Error("Only Readlay's five R2 storage variables may be uploaded.");
  return ["--yes", "vercel@latest", "env", "add", name, "--environment", "production,preview", "--sensitive", "--yes", "--force", "--scope", "holsoma"];
}

export function uploadVariable(name, value, spawnProcess = spawn, environment = process.env) {
  const args = vercelArguments(name);
  const windows = process.platform === "win32";
  const executable = windows ? environment.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "npx";
  const commandArgs = windows ? ["/d", "/s", "/c", ["npx.cmd", ...args].join(" ")] : args;
  const childEnvironment = { ...environment, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" };
  for (const name of Object.keys(childEnvironment)) {
    if (/^(AUTH_|DATABASE_URL$|POSTGRES_|SUPABASE_|AUDIO_|R2_|CF_|CLOUDFLARE_)/.test(name)) delete childEnvironment[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, commandArgs, { cwd: root, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let inputFailed = false;
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => { inputFailed = true; });
    child.on("error", () => reject(new Error(`${name} could not be uploaded. Check the Vercel sign-in and retry.`)));
    child.on("close", (code) => code === 0 && !inputFailed ? resolve() : reject(new Error(`${name} was not confirmed. Check the Vercel sign-in and retry.`)));
    child.stdin.end(`${value}\n`);
  });
}

export async function verifyVercelProject(file = path.join(root, ".vercel", "project.json")) {
  let project;
  try { project = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("Link the workspace to the existing holsoma/readlay Vercel project first. No Vercel changes were made."); }
  if (project.projectName !== "readlay" || project.projectId !== "prj_8q0BAGbufA0TTsLstL8LkmK9wFjU" || project.orgId !== "team_Wmt30x1aiIAIFLHGzoYq11OK") {
    throw new Error("The linked Vercel project does not match the approved holsoma/readlay project. No Vercel changes were made.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && !["--check", "--initialise", "--help"].includes(args[0])) throw new Error("Usage: node --env-file-if-exists=.env.local scripts/audio/configure_r2.mjs [--check|--initialise]");
  if (args[0] === "--help") {
    console.log("Initialise ignored local R2 fields with --initialise, add the private bucket's server-only S3 credentials, then use --check or upload the five R2 fields to the existing Readlay production and preview environments. Values use stdin and are never printed. Existing Supabase, login and database fields are preserved. No deployment runs.");
    return;
  }
  if (args[0] === "--initialise") {
    await initialiseLocalEnvironment();
    console.log("R2 fields initialised in ignored .env.local. Existing storage mode, account and credential values were preserved. No Vercel changes were made.");
    return;
  }
  const values = validatedValues();
  await verifyVercelProject();
  if (args[0] === "--check") {
    console.log("Readlay's five R2 fields are valid and the Vercel project matches. No values printed and no Vercel changes made.");
    return;
  }
  for (const name of VARIABLE_NAMES) {
    console.log(`Uploading ${name} to holsoma/readlay for production and preview.`);
    await uploadVariable(name, values[name]);
  }
  console.log("R2 fields uploaded. Existing Supabase, login and database credentials were preserved. Redeploy separately to apply them.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("R2 setup was not completed. Check the local fields and Vercel sign-in, then retry. No credential values were printed."); process.exitCode = 1; });
}
