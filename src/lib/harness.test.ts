import { describe, expect, it } from "bun:test";
import {
  aiBoardStatusForRun,
  formatCommand,
  isRunBusy,
  mergeRunEvents,
  parseCommand,
  parseEnvLines,
  formatEnvLines,
  type RunEvent,
} from "./harness";

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

describe("agent run status", () => {
  it("projects agent work onto the AI Board without guessing on failure", () => {
    expect(aiBoardStatusForRun("planning")).toBe("doing");
    expect(aiBoardStatusForRun("awaiting_plan")).toBe("doing");
    expect(aiBoardStatusForRun("verifying")).toBe("doing");
    expect(aiBoardStatusForRun("reviewing")).toBe("doing");
    expect(aiBoardStatusForRun("ready_for_review")).toBe("review");
    // Accepted = PR open: it waits in Review; only the owner moves it to Done.
    expect(aiBoardStatusForRun("completed")).toBe("review");
    expect(aiBoardStatusForRun("failed")).toBeNull();
    expect(aiBoardStatusForRun("cancelled")).toBeNull();
  });

  it("only busy runs block another run; waiting ones do not", () => {
    expect(isRunBusy("running")).toBe(true);
    expect(isRunBusy("verifying")).toBe(true);
    expect(isRunBusy("awaiting_plan")).toBe(false);
    expect(isRunBusy("ready_for_review")).toBe(false);
    expect(isRunBusy("completed")).toBe(false);
  });
});

describe("env override lines", () => {
  it("round-trips KEY=value lines and keeps = inside values", () => {
    const vars = parseEnvLines(
      "# per run\nDATABASE_URL=postgres://a:b@{services.db.host}:{services.db.port}/x?ssl=1\n\nPORT={run.port}\n",
    );
    expect(vars).toEqual([
      {
        key: "DATABASE_URL",
        value: "postgres://a:b@{services.db.host}:{services.db.port}/x?ssl=1",
      },
      { key: "PORT", value: "{run.port}" },
    ]);
    expect(parseEnvLines(formatEnvLines(vars))).toEqual(vars);
  });

  it("rejects a line without a key", () => {
    expect(() => parseEnvLines("=value")).toThrow("not KEY=value");
    expect(() => parseEnvLines("JUSTTEXT")).toThrow("not KEY=value");
  });
});
