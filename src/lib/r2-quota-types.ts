export type R2Limits = {
  enabled: boolean; uploadsEnabled: boolean; classAEnabled: boolean; classBEnabled: boolean;
  storageLimitBytes: number; classALimit: number; classBLimit: number; warningPercent: number;
  maxSnapshotAgeSeconds: number; readRequestsPerMinute: number; version: number;
};
export type R2QuotaStatus = {
  limits: R2Limits;
  usage: {
    period: string; reportedStorageBytes: number; pendingStorageBytes: number; effectiveStorageBytes: number;
    reportedClassA: number; reportedClassB: number; reservedClassA: number; reservedClassB: number;
    monthlyClassA: number; monthlyClassB: number;
    effectiveClassA: number; effectiveClassB: number; objectCount: number; pendingMultipartUploads: number;
    observedAt: string | null; storageAt: string | null; inventoryAt: string | null;
  };
  health: { fresh: boolean; inventoryFresh: boolean; lastRefreshError: string | null };
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parseR2Limits(value: unknown): R2Limits | null {
  if (!record(value)) return null;
  for (const name of ["enabled", "uploadsEnabled", "classAEnabled", "classBEnabled"]) if (typeof value[name] !== "boolean") return null;
  const bounds = { storageLimitBytes: 9_000_000_000, classALimit: 999_999, classBLimit: 9_999_999, warningPercent: 99, maxSnapshotAgeSeconds: 93_600, readRequestsPerMinute: 600, version: 2_147_483_647 };
  for (const [name, max] of Object.entries(bounds)) {
    const n = value[name];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < (name === "maxSnapshotAgeSeconds" ? 300 : 1) || n > max) return null;
  }
  return Object.fromEntries([...Object.keys(bounds), "enabled", "uploadsEnabled", "classAEnabled", "classBEnabled"].map(key => [key, value[key]])) as R2Limits;
}
export function parseR2QuotaStatus(value: unknown): R2QuotaStatus | null {
  if (!record(value) || !record(value.usage) || !record(value.health)) return null;
  const limits = parseR2Limits(value.limits);
  if (!limits || typeof value.usage.period !== "string" || !/^\d{4}-\d{2}-01$/.test(value.usage.period)) return null;
  for (const name of ["reportedStorageBytes", "pendingStorageBytes", "effectiveStorageBytes", "reportedClassA", "reportedClassB", "monthlyClassA", "monthlyClassB", "reservedClassA", "reservedClassB", "effectiveClassA", "effectiveClassB", "objectCount", "pendingMultipartUploads"]) {
    const n = value.usage[name];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  }
  for (const name of ["observedAt", "storageAt", "inventoryAt"]) if (value.usage[name] !== null && (typeof value.usage[name] !== "string" || !Number.isFinite(Date.parse(value.usage[name] as string)))) return null;
  if (typeof value.health.fresh !== "boolean" || typeof value.health.inventoryFresh !== "boolean" || (value.health.lastRefreshError !== null && !["analytics_configuration", "analytics_unavailable", "inventory_unavailable"].includes(value.health.lastRefreshError as string))) return null;
  return { limits, usage: value.usage, health: value.health } as R2QuotaStatus;
}

export function quotaWarnings(status: R2QuotaStatus): string[] {
  const { limits: l, usage: u, health: h } = status;
  const warnings: string[] = [];
  if (!h.fresh) warnings.push("Cloudflare usage is missing, stale or could not be verified. R2 requests are paused.");
  if (!h.inventoryFresh) warnings.push("A complete bucket inventory is required before uploading.");
  if (!l.enabled) warnings.push("All Readlay R2 requests are paused by an administrator.");
  if (!l.uploadsEnabled) warnings.push("Uploads are paused by an administrator.");
  if (!l.classAEnabled) warnings.push("Class A requests, including uploads and inventory lists, are paused.");
  if (!l.classBEnabled) warnings.push("Class B requests, including audiobook playback, are paused.");
  if (u.pendingMultipartUploads) warnings.push("Cloudflare reports unfinished multipart uploads. New uploads are blocked. Existing files will not be deleted.");
  for (const [name, used, limit] of [["Storage", u.effectiveStorageBytes, l.storageLimitBytes], ["Class A operations", u.effectiveClassA, l.classALimit], ["Class B operations", u.effectiveClassB, l.classBLimit]] as const) {
    if (used >= limit) warnings.push(`${name} reached the safety limit.`);
    else if (used >= limit * l.warningPercent / 100) warnings.push(`${name} reached the warning threshold.`);
  }
  return warnings;
}
