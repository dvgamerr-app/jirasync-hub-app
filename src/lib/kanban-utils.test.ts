import { describe, expect, it } from "bun:test";
import { deriveTitleFromDetail } from "@/lib/kanban-utils";

describe("deriveTitleFromDetail", () => {
  it("uses the first non-empty line", () => {
    expect(deriveTitleFromDetail("\n\nFix the login bug\n\nMore detail here.")).toBe(
      "Fix the login bug",
    );
  });

  it("strips heading markers", () => {
    expect(deriveTitleFromDetail("### Fix the login bug")).toBe("Fix the login bug");
  });

  it("strips list markers", () => {
    expect(deriveTitleFromDetail("- Fix the login bug")).toBe("Fix the login bug");
    expect(deriveTitleFromDetail("1. Fix the login bug")).toBe("Fix the login bug");
  });

  it("strips blockquote markers", () => {
    expect(deriveTitleFromDetail("> Fix the login bug")).toBe("Fix the login bug");
  });

  it("replaces markdown links with their text", () => {
    expect(deriveTitleFromDetail("Fix [the login bug](https://example.com/ABC-1)")).toBe(
      "Fix the login bug",
    );
  });

  it("strips emphasis and code markers", () => {
    expect(deriveTitleFromDetail("**Fix** the `login` bug")).toBe("Fix the login bug");
  });

  it("truncates long titles with an ellipsis", () => {
    const longLine = "a".repeat(120);
    const title = deriveTitleFromDetail(longLine);
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to Untitled when detail is empty", () => {
    expect(deriveTitleFromDetail("")).toBe("Untitled");
    expect(deriveTitleFromDetail("   \n  \n")).toBe("Untitled");
  });
});
