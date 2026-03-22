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
