"use client";

import { useState, type FormEvent } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { AppShell } from "./AppShell";
import { parseR2QuotaStatus, quotaWarnings, type R2Limits, type R2QuotaStatus } from "@/lib/r2-quota-types";

const number = (value: number) => value.toLocaleString("en-GB");
const gb = (value: number) => `${(value / 1_000_000_000).toLocaleString("en-GB", { maximumFractionDigits: 3 })} GB`;
const date = (value: string | null) => value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : "Not verified";

export function R2UsageDashboard({ initialStatus, initialError, analyticsConfigured }: { initialStatus: R2QuotaStatus | null; initialError: string | null; analyticsConfigured: boolean }) {
  const [status, setStatus] = useState(initialStatus), [draft, setDraft] = useState<R2Limits | null>(initialStatus?.limits ?? null);
  const [busy, setBusy] = useState<"refresh" | "save" | "reload" | null>(null), [error, setError] = useState(initialError), [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  async function request(path: string, body?: unknown) {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : "The request could not be completed.");
    const parsed = parseR2QuotaStatus(value);
    if (!parsed) throw new Error("The usage response could not be verified.");
    return parsed;
  }
  async function run(action: "refresh" | "reload") {
    if (busy) return;
    setBusy(action); setError(null); setMessage("");
    try {
      const next = await request(action === "refresh" ? "/api/admin/r2-usage/refresh" : "/api/admin/r2-usage", action === "refresh" ? {} : undefined);
      setStatus(next);
      if (!dirty || action === "reload") { setDraft(next.limits); setDirty(false); }
      setMessage(action === "refresh" ? "Cloudflare usage and the bucket inventory were refreshed." : "Saved settings loaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Usage could not be refreshed.");
      try { setStatus(await request("/api/admin/r2-usage")); } catch { /* Keep the last visible values, clearly dated. */ }
    } finally { setBusy(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || busy) return;
    setBusy("save"); setError(null); setMessage("");
    try {
      const next = await request("/api/admin/r2-usage", draft);
      setStatus(next); setDraft(next.limits); setDirty(false); setMessage("Safety limits saved. They apply to the next R2 request.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings could not be saved."); }
    finally { setBusy(null); }
  }
  function change<K extends keyof R2Limits>(key: K, value: R2Limits[K]) { setDraft(current => current ? { ...current, [key]: value } : null); setDirty(true); setMessage(""); }
  const warnings = status ? quotaWarnings(status) : [];
  const limits = status?.limits, usage = status?.usage, verified = !!usage?.observedAt;
  const rows = limits && usage ? [
    { name: "Storage", reported: usage.reportedStorageBytes, reserved: usage.pendingStorageBytes, total: usage.effectiveStorageBytes, limit: limits.storageLimitBytes, format: gb,
      paused: !limits.enabled || !limits.uploadsEnabled || !status?.health.inventoryFresh || !!usage.pendingMultipartUploads },
    { name: "Class A operations", reported: usage.reportedClassA, reserved: usage.reservedClassA, total: usage.effectiveClassA, limit: limits.classALimit, format: number, paused: !limits.enabled || !limits.classAEnabled },
    { name: "Class B operations", reported: usage.reportedClassB, reserved: usage.reservedClassB, total: usage.effectiveClassB, limit: limits.classBLimit, format: number, paused: !limits.enabled || !limits.classBEnabled },
  ] : [];
  return <AppShell title="R2 usage"><div className="r2-admin">
    <header className="r2-heading"><div><p className="eyebrow">Administration</p><h1>Storage &amp; request limits</h1><p>Pause Readlay’s R2 requests before they reach your safety limits. This is not a Cloudflare billing cap.</p></div>
      <button className="button" disabled={!!busy} onClick={() => void run("refresh")}><RefreshCw size={16} aria-hidden="true" />{busy === "refresh" ? "Refreshing…" : "Refresh usage"}</button></header>
    <div className="r2-monitor-state"><ShieldCheck size={18} aria-hidden="true" /><span>{status?.health.fresh && limits?.enabled ? "Usage checks active" : "R2 requests require verified usage"}</span><span>Last checked: {date(usage?.observedAt ?? null)}</span></div>
    {!analyticsConfigured && <p className="r2-notice">The Cloudflare Analytics token is missing from this server. Add it before refreshing usage.</p>}
    {error && <p className="r2-notice r2-error" role="alert">{error}</p>}
    {message && <p className="r2-feedback" role="status">{message}</p>}
    {warnings.length > 0 && <section className="r2-warnings" aria-label="Usage warnings"><AlertTriangle size={20} aria-hidden="true" /><ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></section>}
    <section className="r2-usage-section" aria-labelledby="r2-usage-heading"><h2 id="r2-usage-heading">Account usage</h2><p className="r2-caption">Storage includes other buckets in this Cloudflare account. Request protection uses a 31-day window so a calendar reset does not grant a fresh allowance mid-billing period.</p>
      {rows.length > 0 ? <div className="r2-table-scroll" role="region" aria-label="R2 usage statistics" tabIndex={0}><table className="r2-usage-table"><thead><tr><th scope="col">Resource</th><th scope="col">Cloudflare reported</th><th scope="col">Readlay reserved</th><th scope="col">Protected total</th><th scope="col">Safety limit</th></tr></thead><tbody>{rows.map(row => {
        const state = !status?.health.fresh ? "Unverified" : row.paused ? "Paused" : row.total >= row.limit ? "At limit" : row.total >= row.limit * limits!.warningPercent / 100 ? "Warning" : "Within limit";
        return <tr key={row.name}><th scope="row"><strong>{row.name}</strong><span className={`r2-state ${state === "Within limit" ? "is-okay" : ""}`}>{state}</span></th><td>{verified ? row.format(row.reported) : "Not verified"}</td><td>{row.format(row.reserved)}</td><td><strong>{verified ? row.format(row.total) : "Not verified"}</strong>{verified && <meter aria-label={`${row.name} protected usage`} min={0} max={row.limit} value={Math.min(row.total, row.limit)} />}</td><td>{row.format(row.limit)}</td></tr>;
      })}</tbody></table></div> : <p className="r2-notice">Usage is unavailable. R2 requests cannot proceed without the server-side quota service.</p>}
      <p className="r2-caption">Reservations are kept for failed or uncertain requests. Reported requests and recent Readlay reservations deliberately overlap, so protection can pause operations early. Storage reservations are reconciled only against a complete bucket inventory.</p>
      {usage && <dl className="r2-details"><div><dt>Calendar month, UTC</dt><dd>{usage.period.slice(0, 7)}</dd></div><div><dt>Monthly Class A</dt><dd>{verified ? number(usage.monthlyClassA) : "Not verified"}</dd></div><div><dt>Monthly Class B</dt><dd>{verified ? number(usage.monthlyClassB) : "Not verified"}</dd></div><div><dt>Bucket inventory</dt><dd>{date(usage.inventoryAt)}</dd></div></dl>}
    </section>
    <section className="r2-settings" aria-labelledby="r2-settings-heading"><div><h2 id="r2-settings-heading">Safety settings</h2><p className="r2-caption">Storage stays below 9 GB. Class A and B limits must stay below the Standard storage free allowances of 1 million and 10 million requests. Changes do not remove existing files.</p></div>
      {draft && <form onSubmit={save}><fieldset disabled={!!busy}><legend className="sr-only">R2 safety settings</legend><div className="r2-switches">
        {([['enabled', 'Allow Readlay R2 requests'], ['uploadsEnabled', 'Allow uploads'], ['classAEnabled', 'Allow Class A requests'], ['classBEnabled', 'Allow Class B requests']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={draft[key]} onChange={event => change(key, event.target.checked)} /><span>{label}</span></label>)}
      </div><div className="r2-fields"><label>Storage limit, GB<input type="number" required min="0.001" max="9" step="0.001" value={draft.storageLimitBytes / 1e9} onChange={event => change('storageLimitBytes', Math.round(Number(event.target.value) * 1e9))} /></label>
        <label>Class A limit<input type="number" required min="1" max="999999" step="1" value={draft.classALimit} onChange={event => change('classALimit', Number(event.target.value))} /></label>
        <label>Class B limit<input type="number" required min="1" max="9999999" step="1" value={draft.classBLimit} onChange={event => change('classBLimit', Number(event.target.value))} /></label>
        <label>Warn at, %<input type="number" required min="1" max="99" step="1" value={draft.warningPercent} onChange={event => change('warningPercent', Number(event.target.value))} /></label>
      </div></fieldset><div className="r2-form-actions"><button className="button primary" disabled={!!busy || !dirty}>{busy === "save" ? "Saving…" : "Save limits"}</button><button type="button" className="button" disabled={!!busy} onClick={() => void run("reload")}>{busy === "reload" ? "Loading…" : "Reload saved settings"}</button>{dirty && <span>Unsaved changes</span>}</div></form>}
    </section>
    <section className="r2-limitations" aria-labelledby="r2-limitations-heading"><h2 id="r2-limitations-heading">What these controls cannot stop</h2><ul>
      <li>Direct S3 clients, other API keys, Workers, public custom domains and r2.dev access can bypass Readlay. Keep the bucket private and remove unnecessary access paths.</li>
      <li>Previously issued signed URLs keep working until they expire. CORS is not an authorisation or billing control.</li>
      <li>Cloudflare analytics can be delayed or sampled. Other buckets share the allowance, and unfinished multipart uploads can consume storage.</li>
      <li>Only Standard storage has the stated free allowance. Other Cloudflare products and Vercel streaming can have their own limits and charges.</li>
    </ul><p>No files are deleted automatically. Check Cloudflare’s own usage and billing pages as well. Readlay cannot guarantee zero Cloudflare charges.</p>
      <a href="https://developers.cloudflare.com/r2/pricing/" target="_blank" rel="noopener noreferrer">Cloudflare R2 pricing and allowances</a></section>
  </div></AppShell>;
}
