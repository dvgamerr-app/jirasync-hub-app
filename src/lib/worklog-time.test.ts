import { describe, expect, it } from "vitest";
import { parseTimeInput, formatMinutes } from "@/lib/worklog-time";

describe("parseTimeInput", () => {
  it("returns null for empty string", () => {
    expect(parseTimeInput("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(parseTimeInput("   ")).toBeNull();
  });

  it("returns null for non-numeric text with no unit", () => {
    expect(parseTimeInput("abc")).toBeNull();
  });

  it("parses minutes only", () => {
    expect(parseTimeInput("30m")).toBe(30);
  });

  it("parses hours only", () => {
    expect(parseTimeInput("2h")).toBe(120);
  });

  it("parses days only (1d = 480m)", () => {
    expect(parseTimeInput("1d")).toBe(480);
  });

  it("parses mixed d h m input", () => {
    expect(parseTimeInput("1d 2h 30m")).toBe(480 + 120 + 30);
  });

  it("parses hours and minutes without days", () => {
    expect(parseTimeInput("1h 45m")).toBe(60 + 45);
  });

  it("treats a bare number as hours (60m per unit)", () => {
    // "2" → 2 * 60 = 120m
    expect(parseTimeInput("2")).toBe(120);
  });

  it("handles decimal days (0.5d = 240m)", () => {
    expect(parseTimeInput("0.5d")).toBe(240);
  });

  it("handles decimal hours (1.5h = 90m)", () => {
    expect(parseTimeInput("1.5h")).toBe(90);
  });

  it("trims leading/trailing whitespace", () => {
    expect(parseTimeInput("  1h  ")).toBe(60);
  });

  it("is case-insensitive", () => {
    expect(parseTimeInput("1H 30M")).toBe(90);
  });

  it("returns null when result rounds to zero", () => {
    // 0d 0h 0m → total 0 → null
    expect(parseTimeInput("0m")).toBeNull();
  });

  it("returns null for input with unknown unit suffix (e.g. '1.5m')", () => {
    // \d+ regex for minMatch won't match '1.5m'; must not silently treat as 1.5 hours
    expect(parseTimeInput("1.5m")).toBeNull();
  });

  it("returns null for '0d'", () => {
    expect(parseTimeInput("0d")).toBeNull();
  });

  it("returns null for '0h'", () => {
    expect(parseTimeInput("0h")).toBeNull();
  });

  it("returns null for input with trailing unit letters and no valid unit (e.g. '5x')", () => {
    expect(parseTimeInput("5x")).toBeNull();
  });
});

describe("formatMinutes", () => {
  it("formats 0 minutes as '0m'", () => {
    expect(formatMinutes(0)).toBe("0m");
  });

  it("formats minutes below an hour as 'Xm'", () => {
    expect(formatMinutes(45)).toBe("45m");
  });

  it("formats exactly 1 hour as '1h'", () => {
    expect(formatMinutes(60)).toBe("1h");
  });

  it("formats hours and minutes", () => {
    expect(formatMinutes(90)).toBe("1h 30m");
  });

  it("formats exactly 1 day (480m) as '1d'", () => {
    expect(formatMinutes(480)).toBe("1d");
  });

  it("formats 1 day 2 hours 30 minutes", () => {
    expect(formatMinutes(480 + 120 + 30)).toBe("1d 2h 30m");
  });

  it("does not include zero parts in the output", () => {
    expect(formatMinutes(480 + 30)).toBe("1d 30m");
  });

  it("formats large values correctly", () => {
    // 2d 3h 15m = 2*480 + 3*60 + 15 = 960 + 180 + 15 = 1155
    expect(formatMinutes(1155)).toBe("2d 3h 15m");
  });
});
