import { describe, expect, it } from "bun:test";
import { formatCommand, mergeRunEvents, parseCommand, type RunEvent } from "./harness";

describe("parseCommand / formatCommand", () => {
  it("splits an executable and its arguments", () => {
    expect(parseCommand("  bun run  test ")).toEqual({ executable: "bun", args: ["run", "test"] });
  });

  it("keeps quoted arguments with spaces together and round-trips them", () => {
    const command = parseCommand('npm run "e2e smoke" --silent');
    expect(command).toEqual({ executable: "npm", args: ["run", "e2e smoke", "--silent"] });
    expect(formatCommand(command)).toBe('npm run "e2e smoke" --silent');
  });

  it("treats empty text as no command", () => {
    expect(parseCommand("   ")).toBeNull();
    expect(formatCommand(null)).toBe("");
  });

  it("rejects an unclosed quote instead of guessing", () => {
    expect(() => parseCommand('bun run "test')).toThrow("Unclosed quote");
  });

  it("does not interpret shell syntax", () => {
    expect(parseCommand("bun test && rm -rf /")).toEqual({
      executable: "bun",
      args: ["test", "&&", "rm", "-rf", "/"],
    });
  });
});

describe("mergeRunEvents", () => {
  const output = (seq: number, text = `line ${seq}`): RunEvent => ({
    runId: "abc123",
    seq,
    at: seq,
    type: "output",
    step: "install",
    stream: "stdout",
    text,
  });

  it("drops replayed duplicates and restores sequence order", () => {
    const merged = mergeRunEvents([output(1), output(3)], [output(2), output(3), output(1)]);
    expect(merged.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("keeps only the newest events past the cap", () => {
    const merged = mergeRunEvents(
      [],
      [1, 2, 3, 4, 5].map((seq) => output(seq)),
      3,
    );
    expect(merged.map((event) => event.seq)).toEqual([3, 4, 5]);
  });

  it("does not drop anything under the cap", () => {
    expect(mergeRunEvents([output(1)], [output(2)], 3)).toHaveLength(2);
  });
});
