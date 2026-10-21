/** GitHub's stable numeric ID, never a display name, email or user-editable claim. */
export function isReadlayAdminId(id: unknown): boolean {
  if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) return false;
  return (process.env.READLAY_ADMIN_GITHUB_IDS || "").split(",").map(item => item.trim()).filter(item => /^\d{1,30}$/.test(item)).includes(id);
}
