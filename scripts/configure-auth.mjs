#!/usr/bin/env node

// Run with: node --env-file-if-exists=.env.local scripts/configure-auth.mjs
// This only uploads the two GitHub OAuth values. It never downloads Vercel secrets.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const names = ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"];
const scope = "holsoma";

export function createRedactor(values) {
  const forms = [...new Set(values.filter(Boolean).flatMap((value) => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]))].sort((a, b) => b.length - a.length);
  return (output) => {
    let text = stripVTControlCharacters(String(output));
    for (const value of forms) text = text.split(value).join("[redacted]");
    return text;
  };
}

export function vercelArguments(name) {
  if (!names.includes(name)) throw new Error("Only Readlay's two GitHub OAuth values may be uploaded.");
  // This environment flag is supported by the installed Vercel CLI 64.7.0.
  return ["--yes", "vercel@latest", "env", "add", name, "--environment", "production,preview", "--sensitive", "--yes", "--force", "--scope", scope];
}

function upload(name, value, redact) {
  return new Promise((resolve, reject) => {
    const args = vercelArguments(name);
    const windows = process.platform === "win32";
    // On Windows .cmd files require cmd.exe. Every argument is a fixed allowlisted token.
    // The credential is sent through stdin, so it never enters a shell command or argv.
    const executable = windows ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "npx";
    const commandArgs = windows ? ["/d", "/s", "/c", ["npx.cmd", ...args].join(" ")] : args;
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^(AUTH_|DATABASE_URL$|POSTGRES_|SUPABASE_|AUDIO_)/.test(key)) delete childEnv[key];
    }
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env: { ...childEnv, NO_COLOR: "1", VERCEL_TELEMETRY_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = { stdout: [], stderr: [] };
    let outputBytes = 0;
    let outputOmitted = false;
    let inputFailed = false;
    const capture = (stream) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 512 * 1024) {
        output.stdout.length = 0;
        output.stderr.length = 0;
        outputOmitted = true;
      } else if (!outputOmitted) output[stream].push(chunk);
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.stdin.on("error", () => { inputFailed = true; });
    child.on("error", (error) => reject(new Error(redact(error.message))));
    child.on("close", (code) => {
      // Redact after joining chunks so a value split between chunks cannot leak.
      const message = outputOmitted ? "Vercel output omitted because it exceeded the size limit.\n" : ["stdout", "stderr"].map((stream) => redact(Buffer.concat(output[stream]).toString("utf8"))).filter(Boolean).join("\n");
      if (message.trim()) process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
      if (code !== 0 || inputFailed) reject(new Error(`${name} was not confirmed. Check the Vercel sign-in and retry this script.`));
      else resolve();
    });
    child.stdin.end(`${value}\n`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || !["--check", "--help"].includes(args[0]))) {
    throw new Error("Usage: node --env-file-if-exists=.env.local scripts/configure-auth.mjs [--check]");
  }
  if (args[0] === "--help") {
    console.log("Read AUTH_GITHUB_ID and AUTH_GITHUB_SECRET from the process environment and upload them to holsoma/readlay for production and preview. Existing values are replaced. Use --check to validate without uploading. AUTH_SECRET is unchanged.");
    return;
  }
  const credentials = names.map((name) => ({ name, value: process.env[name]?.trim() || "" }));
  const missing = credentials.filter(({ value }) => !value).map(({ name }) => name);
  if (missing.length) throw new Error(`Add ${missing.join(" and ")} to .env.local before running this script. No Vercel changes were made.`);
  if (credentials.some(({ value }) => /[\s\u0000-\u001f\u007f]/.test(value) || value.length > 4096)) {
    throw new Error("GitHub OAuth values must contain no whitespace or control characters and be at most 4096 characters. No Vercel changes were made.");
  }
  let project;
  try { project = JSON.parse(await readFile(path.join(root, ".vercel", "project.json"), "utf8")); }
  catch { throw new Error("Link this workspace to holsoma/readlay with the Vercel CLI first. No Vercel changes were made."); }
  if (project.projectName !== "readlay" || typeof project.projectId !== "string" || !project.projectId || typeof project.orgId !== "string" || !project.orgId) {
    throw new Error("The linked Vercel project must be Readlay. No Vercel changes were made.");
  }
  if (args[0] === "--check") {
    console.log("Both GitHub OAuth values are present. The workspace is linked to Readlay. Ready to upload to production and preview; no Vercel changes were made.");
    return;
  }
  const redact = createRedactor(credentials.map(({ value }) => value));
  for (const { name, value } of credentials) {
    console.log(`Uploading ${name} to ${scope}/readlay for production and preview…`);
    await upload(name, value, redact);
  }
  console.log("GitHub OAuth values uploaded. Redeploy Readlay to apply them. AUTH_SECRET was unchanged.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // Also redact the final error path. No raw CLI output is streamed to the terminal.
  const redact = createRedactor(names.map((name) => process.env[name]?.trim() || ""));
  main().catch((error) => { console.error(redact(error.message)); process.exitCode = 1; });
}
