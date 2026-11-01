type AdfNodeLike = {
  type?: string;
  text?: string;
  content?: AdfNodeLike[];
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
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

/** Export visible description content without applying search normalization. */
export function adfToMarkdown(description: string | null | undefined): string {
  if (!description) return "";
  const doc = parseAdfDocument(description);
  if (!doc) return description;
  const escape = (value: string) => value.replace(/[\\`*_[\]<>]/g, "\\$&");
  const render = (node: AdfNodeLike, depth = 0): string => {
    if (!node || typeof node !== "object") return "";
    const children = Array.isArray(node.content) ? node.content : [];
    const body = () => children.map((child) => render(child, depth)).join("");
    if (node.type === "text") {
      const raw = typeof node.text === "string" ? node.text : "";
      const marks = Array.isArray(node.marks)
        ? node.marks.filter((mark) => mark && typeof mark === "object")
        : [];
      let text = escape(raw);
      if (marks.some((mark) => mark.type === "code")) {
        const fence = "`".repeat(Math.max(1, ...(raw.match(/`+/g) ?? []).map((s) => s.length + 1)));
        text = `${fence} ${raw} ${fence}`;
      }
      for (const mark of marks) {
        if (mark.type === "strong") text = `**${text}**`;
        if (mark.type === "em") text = `*${text}*`;
        if (mark.type === "link") {
          const url = getSafeExternalUrl(mark.attrs?.href);
          if (url) text = `[${text}](<${url.replace(/>/g, "%3E")}>)`;
        }
      }
      return text;
    }
    switch (node.type) {
      case "doc":
        return body().trim();
      case "paragraph":
        return `${body()}\n\n`;
      case "heading":
        return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${body()}\n\n`;
      case "hardBreak":
        return "\n";
      case "rule":
        return "\n---\n\n";
      case "codeBlock": {
        const raw = children
          .map((child) => (typeof child.text === "string" ? child.text : ""))
          .join("");
        const fence = "`".repeat(Math.max(3, ...(raw.match(/`+/g) ?? []).map((s) => s.length + 1)));
        const language =
          typeof node.attrs?.language === "string"
            ? node.attrs.language.replace(/[^\w+-]/g, "")
            : "";
        return `${fence}${language}\n${raw}\n${fence}\n\n`;
      }
      case "bulletList":
      case "orderedList": {
        const start = Number(node.attrs?.order) || 1;
        return (
          children
            .map((child, i) => {
              const marker = node.type === "orderedList" ? `${start + i}. ` : "- ";
              const lines = render(child, depth + 1)
                .trim()
                .split("\n");
              return marker + lines.join(`\n${" ".repeat(marker.length)}`);
            })
            .join("\n") + "\n\n"
        );
      }
      case "listItem":
        return body();
      case "blockquote":
        return (
          body()
            .trim()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n") + "\n\n"
        );
      case "inlineCard":
      case "blockCard":
        return getSafeExternalUrl(node.attrs?.url) ?? "[Link unavailable]";
      case "mention":
        return escape(typeof node.attrs?.text === "string" ? node.attrs.text : "[Mention]");
      case "emoji":
        return escape(String(node.attrs?.text ?? node.attrs?.shortName ?? "[Emoji]"));
      case "status":
        return escape(String(node.attrs?.text ?? "[Status]"));
      case "media":
        return "[Attachment unavailable offline]";
      default:
        return body();
    }
  };
  return render(doc);
}
