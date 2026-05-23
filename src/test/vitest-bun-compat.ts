// Compatibility shim: maps bun:test API surface to vitest equivalents.
// Aliased as "bun:test" in vitest.config.ts so test files run under both runners.
import { vi } from "vitest";
export { describe, it, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";

export const spyOn = vi.spyOn;

// jest namespace (clearAllMocks, etc.)
export const jest = vi;

// mock() = vi.fn(); mock.module() is transformed to vi.mock() by bunTestCompatPlugin
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMock<T extends (...args: any[]) => any>(impl?: T) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn<(...args: any[]) => any>(impl);
}
// Placeholder: bunTestCompatPlugin transforms mock.module( → vi.mock( in source
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(createMock as any).module = vi.mock;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(createMock as any).restore = () => vi.restoreAllMocks();

export const mock = createMock as typeof createMock & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module: (path: string, factory?: () => any) => void;
  restore: () => void;
};
