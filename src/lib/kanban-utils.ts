const TITLE_MAX_LENGTH = 80;

/** Derives a card title from the first non-empty line of its markdown detail. */
export function deriveTitleFromDetail(detail: string): string {
  const firstLine = detail
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return "Untitled";

  const plain = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();

  if (!plain) return "Untitled";
  if (plain.length <= TITLE_MAX_LENGTH) return plain;
  return `${plain.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}
