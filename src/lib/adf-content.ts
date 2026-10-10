type AdfNodeLike = {
  type?: string;
  text?: string;
  content?: AdfNodeLike[];
};

function parseAdfDocument(content: string): AdfNodeLike | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && (parsed as AdfNodeLike).type === "doc") {
      return parsed as AdfNodeLike;
    }
  } catch {
    // Not JSON — fall through to plain text.
  }

  return null;
}

function hasRenderableContent(node: AdfNodeLike): boolean {
  if ((node.text ?? "").trim().length > 0) {
    return true;
  }

  switch (node.type) {
    case "emoji":
    case "mention":
    case "status":
    case "inlineCard":
    case "blockCard":
    case "media":
      return true;
    default:
      return node.content?.some(hasRenderableContent) ?? false;
  }
}

export function hasAdfContent(content: string | null | undefined): boolean {
  const normalizedContent = content?.trim();
  if (!normalizedContent) return false;

  const adf = parseAdfDocument(normalizedContent);
  if (!adf) return normalizedContent.length > 0;

  return adf.content?.some(hasRenderableContent) ?? false;
}

function collectAdfText(node: AdfNodeLike, parts: string[]): void {
  if (node.text) parts.push(node.text);
  for (const child of node.content ?? []) collectAdfText(child, parts);
  // keep words from adjacent blocks (paragraphs, list items…) from running together
  if (node.type && node.type !== "text") parts.push(" ");
}

const plainTextCache = new Map<string, string>();
const PLAIN_TEXT_CACHE_LIMIT = 5000;

/**
 * Lower-cased visible text of a task description, for searching. Descriptions are stored as ADF
 * JSON, so searching the raw string would match structural words like "paragraph" or "doc".
 */
export function getDescriptionSearchText(description: string | null | undefined): string {
  if (!description) return "";
  const cached = plainTextCache.get(description);
  if (cached !== undefined) return cached;

  const adf = parseAdfDocument(description);
  let text = description;
  if (adf) {
    const parts: string[] = [];
    collectAdfText(adf, parts);
    text = parts.join("");
  }
  const normalized = text.toLowerCase();

  if (plainTextCache.size >= PLAIN_TEXT_CACHE_LIMIT) plainTextCache.clear();
  plainTextCache.set(description, normalized);
  return normalized;
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the URL when it is safe to hand to the system browser, otherwise null. Descriptions
 * are written by anyone with access to the ticket, so `javascript:` / `file:` links must never
 * become clickable.
 */
export function getSafeExternalUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}
