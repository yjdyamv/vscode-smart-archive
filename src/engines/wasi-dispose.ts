/**
 * Terminate the WASI worker threads behind a generated napi-rs WASI binding.
 *
 * `reset<Rar5,Snappy>BindingCache()` used to only drop the JS reference. The
 * `@emnapi/wasi-threads` workers that the WASI loader spawned stayed alive
 * until process exit, and an unlucky one threw
 * `RuntimeError: memory access out of bounds` from `MessageHandler._start`
 * *after* the test that created it had finished — vitest reports that as an
 * unhandled error, so `npm test` exited 1 even though all 840 tests passed.
 *
 * The generated loader exposes the release hook as
 * `binding[Symbol.for('napi.rs.wasi.dispose')]()`, which terminates every
 * worker and is idempotent, so use it. Best effort by design: a native
 * binding (no symbol) is a no-op, and a failed terminate must not fail a
 * settings change.
 */
const WASI_DISPOSE = Symbol.for("napi.rs.wasi.dispose");

export async function disposeWasiBinding(binding: unknown): Promise<void> {
  if (binding === null || binding === undefined) return;
  if (typeof binding !== "object" && typeof binding !== "function") return;
  const dispose = (binding as Record<symbol, unknown>)[WASI_DISPOSE];
  if (typeof dispose !== "function") return;
  try {
    await (dispose as () => unknown).call(binding);
  } catch {
    // Best effort: the loader marks the binding disposed either way, and the
    // callers have already dropped their reference to it.
  }
}
