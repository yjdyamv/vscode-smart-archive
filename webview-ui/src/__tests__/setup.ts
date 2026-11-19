import { vi } from "vitest";
import { config } from "@vue/test-utils";
import { vTip } from "../directives/tooltip";

(globalThis as any).acquireVsCodeApi = vi.fn(() => ({
  postMessage: vi.fn(),
  setState: vi.fn(),
  getState: vi.fn(() => undefined),
}));

// Mirror main.ts (createApp(App).directive("tip", vTip)) so every mounted
// component resolves `v-tip` like production, instead of emitting
// "Failed to resolve directive: tip". The directive is inert until hover or
// focus, so this adds no side effects to tests that don't exercise it.
config.global.directives = { ...config.global.directives, tip: vTip };
