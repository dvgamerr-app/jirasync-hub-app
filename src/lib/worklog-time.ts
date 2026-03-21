/** 1d = 8h = 480m (standard Jira convention) */
export function parseTimeInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  let total = 0;
  const dayMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*d/);
  const hourMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*h/);
  const minMatch = trimmed.match(/(\d+)\s*m/);

  if (dayMatch) total += parseFloat(dayMatch[1]) * 480;
  if (hourMatch) total += parseFloat(hourMatch[1]) * 60;
  if (minMatch) total += parseInt(minMatch[1]);

  if (!dayMatch && !hourMatch && !minMatch) {
    const num = parseFloat(trimmed);
    if (!isNaN(num)) {
      total = num * 60;
    } else {
      return null;
    }
  }

  return Math.round(total) || null;
}

export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / 480);
  const h = Math.floor((minutes % 480) / 60);
  const m = minutes % 60;
  const parts: string[] = [];

  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);

  return parts.join(" ");
}
