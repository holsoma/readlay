export function readingTime(minutes: number | null | undefined) {
  if (!minutes) return "Time unavailable";
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours ? `${hours}h${remaining ? ` ${remaining}m` : ""}` : `${remaining} min`;
}
