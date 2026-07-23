import { vi } from "vitest";

(globalThis as any).acquireVsCodeApi = vi.fn(() => ({
  postMessage: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(() => undefined),
}));
