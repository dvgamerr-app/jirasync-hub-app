import { describe, expect, it } from "bun:test";
import { adfToMarkdown, getDescriptionSearchText, hasAdfContent } from "@/lib/adf-content";

function adfDoc(content: unknown[]): string {
  return JSON.stringify({ type: "doc", version: 1, content });
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function emptyParagraph() {
  return { type: "paragraph", content: [] };
}

describe("adfToMarkdown", () => {
  it("preserves plain text and handles absent descriptions", () => {
    expect(adfToMarkdown("Keep API Case")).toBe("Keep API Case");
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown("{broken")).toBe("{broken");
  });
  it("preserves case without changing search normalization", () => {
    const description = adfDoc([paragraph("Use API Token")]);
    expect(adfToMarkdown(description)).toBe("Use API Token");
    expect(getDescriptionSearchText(description)).toContain("use api token");
  });
  it("preserves code containing markdown fences", () => {
    const description = adfDoc([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const Code = ` ``` `;" }],
      },
    ]);
    expect(adfToMarkdown(description)).toBe("````ts\nconst Code = ` ``` `;\n````");
  });
  it("preserves nested lists", () => {
    const description = adfDoc([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("Parent"),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph("Child")] }],
              },
            ],
          },
        ],
      },
    ]);
    expect(adfToMarkdown(description)).toContain("- Parent\n  \n  - Child");
  });
  it("exports safe links while excluding unsafe destinations", () => {
    const description = adfDoc([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Docs",
            marks: [{ type: "link", attrs: { href: "https://example.com/docs" } }],
          },
          {
            type: "text",
            text: "Danger",
            marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
          },
        ],
      },
    ]);
    expect(adfToMarkdown(description)).toContain("[Docs](<https://example.com/docs>)");
    expect(adfToMarkdown(description)).toContain("Danger");
    expect(adfToMarkdown(description)).not.toContain("javascript:");
  });
});

describe("hasAdfContent", () => {
  it("returns false for null", () => {
    expect(hasAdfContent(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasAdfContent(undefined)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(hasAdfContent("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(hasAdfContent("   ")).toBe(false);
  });

  it("returns true for plain text (non-JSON)", () => {
    expect(hasAdfContent("Some plain description")).toBe(true);
  });

  it("returns true for ADF doc with text content", () => {
    expect(hasAdfContent(adfDoc([paragraph("Hello")]))).toBe(true);
  });

  it("returns false for ADF doc with only empty paragraphs", () => {
    expect(hasAdfContent(adfDoc([emptyParagraph()]))).toBe(false);
  });

  it("returns false for ADF doc with no content array", () => {
    expect(hasAdfContent(JSON.stringify({ type: "doc", version: 1 }))).toBe(false);
  });

  it("returns false for ADF doc with empty content array", () => {
    expect(hasAdfContent(adfDoc([]))).toBe(false);
  });

  it("returns true for ADF doc containing an emoji node", () => {
    const emoji = { type: "emoji", attrs: { shortName: ":smile:" } };
    expect(hasAdfContent(adfDoc([{ type: "paragraph", content: [emoji] }]))).toBe(true);
  });

  it("returns true for ADF doc containing a mention node", () => {
    const mention = { type: "mention", attrs: { id: "user-1" } };
    expect(hasAdfContent(adfDoc([{ type: "paragraph", content: [mention] }]))).toBe(true);
  });

  it("returns true for ADF doc containing a media node", () => {
    const media = { type: "media", attrs: { id: "att-1", type: "file" } };
    expect(hasAdfContent(adfDoc([{ type: "mediaSingle", content: [media] }]))).toBe(true);
  });

  it("treats non-doc JSON as plain text and returns true when non-empty", () => {
    // parseAdfDocument returns null for type !== 'doc', so the string is treated
    // as plain text and hasAdfContent returns true for any non-empty string.
    expect(hasAdfContent(JSON.stringify({ type: "paragraph", content: [] }))).toBe(true);
    expect(hasAdfContent(JSON.stringify({ type: "paragraph" }))).toBe(true);
  });

  it("returns true for a whitespace-only text node inside ADF", () => {
    // hasRenderableContent checks .trim().length > 0, so whitespace text → false
    const whitespaceOnly = adfDoc([
      { type: "paragraph", content: [{ type: "text", text: "   " }] },
    ]);
    expect(hasAdfContent(whitespaceOnly)).toBe(false);
  });

  it("returns true for nested ADF content that has renderable text", () => {
    const nested = adfDoc([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [paragraph("Item one")],
          },
        ],
      },
    ]);
    expect(hasAdfContent(nested)).toBe(true);
  });
});
