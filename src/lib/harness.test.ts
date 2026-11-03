import { describe, expect, it } from "bun:test";
import { formatCommand, parseCommand } from "./harness";

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
