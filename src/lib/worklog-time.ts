const MINUTES_PER_DAY = 480; // 8h × 60m (standard Jira workday)
const MINUTES_PER_HOUR = 60;

/** 1d = 8h = 480m (standard Jira convention) */
export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  let total = 0;
  const dayMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*d/);
  const hourMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*h/);
  const minMatch = trimmed.match(/(?<!\.)(\d+)\s*m(?!\w)/);

  if (dayMatch) total += parseFloat(dayMatch[1]) * MINUTES_PER_DAY;
  if (hourMatch) total += parseFloat(hourMatch[1]) * MINUTES_PER_HOUR;
  if (minMatch) total += parseInt(minMatch[1], 10);

  if (!dayMatch && !hourMatch && !minMatch) {
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      total = num * MINUTES_PER_HOUR;
    } else {
      return null;
    }
  }

  return Math.round(total) || null;
}

export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / MINUTES_PER_DAY);
  const h = Math.floor((minutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const m = minutes % MINUTES_PER_HOUR;
  const parts: string[] = [];

  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);

  return parts.join(" ");
}

/** Formats a manday value (1 = 8h) for display, e.g. 1.5 → "1d 4h". Returns "" for null. */
export function formatMandays(value: number | null): string {
  return value != null ? formatMinutes(Math.round(value * MINUTES_PER_DAY)) : "";
}

/**
 * Converts a manday value (1 = 8h) to a Jira-compatible estimate string and seconds.
 * Used when pushing timetracking back to Jira.
 */
export function formatMandayEstimate(mandays: number): { str: string; seconds: number } {
  const totalMinutes = Math.round(mandays * 8 * 60);
  const seconds = totalMinutes * 60;
  const d = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const h = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const m = totalMinutes % MINUTES_PER_HOUR;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return { str: parts.join(" ") || "0m", seconds };
}
