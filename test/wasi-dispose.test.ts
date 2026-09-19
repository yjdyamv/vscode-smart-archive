/**
 * `disposeWasiBinding` is what keeps `npm test` green.
 *
 * The generated WASI loader exposes `Symbol.for("napi.rs.wasi.dispose")`,
 * which terminates the `@emnapi/wasi-threads` workers. Dropping the JS
 * reference without calling it left those workers alive, and their startup
 * could throw `RuntimeError: memory access out of bounds` *after* the test
 * that created them finished — vitest reports that as an unhandled error, so
 * the run exited 1 although every test passed. The hook is symbol-keyed and
 * optional, so both paths matter: present -> called once; absent (native
 * bindings, non-objects) -> no-op; failing -> swallowed.
 */
import { describe, expect, it, vi } from "vitest";
import { disposeWasiBinding } from "../src/engines/wasi-dispose";

const WASI_DISPOSE = Symbol.for("napi.rs.wasi.dispose");

describe("disposeWasiBinding", () => {
  it("calls the loader's dispose hook when present", async () => {
    const dispose = vi.fn(async () => {});
    await disposeWasiBinding({ [WASI_DISPOSE]: dispose });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for native bindings and non-objects", async () => {
    await expect(disposeWasiBinding({ compress: () => {} })).resolves.toBeUndefined();
    await expect(disposeWasiBinding(undefined)).resolves.toBeUndefined();
    await expect(disposeWasiBinding(null)).resolves.toBeUndefined();
    await expect(disposeWasiBinding(42)).resolves.toBeUndefined();
  });

  it("swallows a failing dispose (best effort)", async () => {
    const dispose = vi.fn(() => {
      throw new Error("already gone");
    });
    await expect(disposeWasiBinding({ [WASI_DISPOSE]: dispose })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalled();
  });
});
