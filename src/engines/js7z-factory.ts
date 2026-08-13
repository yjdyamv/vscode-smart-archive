/**
 * js7z factory — Smart Archive VSCode Extension
 *
 * Provides the `JS7z` factory over the bundled 7-Zip ZS 26.02 WebAssembly
 * engine (vendor/7zz-wasm, see scripts/install-7zz-wasm.js), replacing the
 * old js7z-tools (7-Zip 25.01) WASM build. Same call contract as before:
 *
 *   const js7z = await JS7z({ print, printErr });
 *   js7z.FS.writeFile("/in/x", data);        // emscripten virtual FS
 *   js7z.onExit = (code) => { ... };
 *   js7z.callMain(["a", "/out/x.7z", "/in/x"]);
 *   disposeJS7z(js7z);                        // no-op with a shared instance
 *
 * Implementation notes (the 7zz engine differs from js7z-tools in ways the
 * rest of the extension must never notice):
 *
 * 1. SHARED INSTANCE — the MT wasm build spawns a pthread worker pool
 *    (4 threads) that strongly references the instance, so V8 GC can never
 *    collect it; creating a fresh instance per operation would leak memory
 *    and threads. Instead one instance is cached per worker (module scope)
 *    and reused. All archive operations are serialized by the worker FIFO
 *    queue, and every dual-instance use (compress-core tar wrapping, wrapped
 *    extract/modify/list) is strictly sequential — data is copied out before
 *    the next JS7z() call — so sharing is safe. The virtual FS is reset on
 *    every JS7z() call so callers still see a clean /in, /out, root.
 *
 * 2. PRINT / PRINTERR — Emscripten binds stdout to a char-code device at
 *    module init; assigning `inst.print` afterwards has no effect, and the
 *    7-Zip progress bar uses \b/\r instead of newlines (which would stall
 *    the default line-buffered TTY path). So stdout/stderr are captured as
 *    char codes here, backspaces are applied, and text is emitted per line
 *    boundary (\n or \r), with progress redraws flushed at each backspace run
 *    when they carry a percent — to the active print/printErr callbacks.
 *    Both the construction-time options and later direct assignment are
 *    supported.
 *
 * 3. ONEXIT — the 7zz build does not invoke Module.onExit (its callMain
 *    returns the exit code synchronously). `callMain` is wrapped to fire
 *    onExit(code) with the returned code, keeping the Promise-based
 *    run7z/list flows working unchanged. A synchronous callMain throw
 *    (engine crash, memory guard) does NOT fire onExit: exit code 1 is the
 *    recoverable "warning" contract, and a crash must never masquerade as
 *    one — the exception propagates so callers fail loudly instead of
 *    accepting a partial result.
 *
 * 4. DESTROY — no native cleanup exists on this build (same as js7z-tools);
 *    disposeJS7z is therefore a no-op. The shared instance is intentional:
 *    nothing is leaked because nothing is ever dropped.
 *
 * @module engines/js7z-factory
 */

import type { JS7zFactory, JS7zInstance } from "../types";

type Create7zz = (opts?: Record<string, unknown>) => Promise<JS7zInstance>;

type PrintCb = ((text: string) => void) | undefined;

interface CachedEngine {
  inst: JS7zInstance;
  print: PrintCb;
  printErr: PrintCb;
  exitCb: ((code: number) => void) | null;
}

let cached: CachedEngine | null = null;
let initPromise: Promise<CachedEngine> | null = null;

/**
 * Load the bundled 7-Zip ZS wasm engine (staged by
 * scripts/install-7zz-wasm.js). Kept external from the vite bundle so 7zz.js
 * can resolve 7zz.wasm via its own __dirname at runtime
 * (see vite.extension.config.ts). The require is lazy so a missing download
 * only fails WASM operations, never extension startup or system-7z paths.
 */
function loadCreate7zz(): Create7zz {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../vendor/7zz-wasm/7zz.js") as Create7zz;
  } catch (err) {
    throw new Error(
      "Bundled 7zz WASM engine not found (vendor/7zz-wasm/7zz.js). " +
        "Run `node scripts/install-7zz-wasm.js` to stage it.",
      { cause: err },
    );
  }
}

/** Backspace-aware line assembly from the char-code device. */
function makeAssembler(setText: (t: string) => void): (code: number) => void {
  let buf: number[] = [];
  return (code: number) => {
    if (code === 8) {
      // \b — 7-Zip redraws progress with backspaces (no \r/\n between
      // updates). Before erasing, flush the current line when it carries a
      // percent so progress reaches the callbacks in real time.
      if (buf.includes(37 /* '%' */)) {
        const text = new TextDecoder().decode(Uint8Array.from(buf));
        buf = [];
        setText(text);
      }
      buf.pop();
      return;
    }
    buf.push(code);
    if (code === 10 || code === 13) {
      // line boundary (\n or \r): emit what was accumulated
      const text = new TextDecoder().decode(Uint8Array.from(buf));
      buf = [];
      setText(text);
    }
  };
}

function resetFS(inst: JS7zInstance): void {
  const FS = inst.FS;
  try {
    FS.chdir("/");
  } catch {
    /* ignore */
  }
  const remove = (p: string): void => {
    let st;
    try {
      st = FS.stat(p);
    } catch {
      return; // already gone
    }
    if (FS.isDir(st.mode)) {
      for (const e of FS.readdir(p)) {
        if (e === "." || e === "..") continue;
        remove(`${p}/${e}`);
      }
      try {
        FS.rmdir(p);
      } catch {
        /* ignore */
      }
    } else {
      try {
        FS.unlink(p);
      } catch {
        /* ignore */
      }
    }
  };
  for (const e of FS.readdir("/")) {
    if (e === "." || e === "..") continue;
    remove(`/${e}`);
  }
}

/**
 * Lazily create (or reuse) the shared wasm instance and return it with
 * callbacks bound to the caller's options. Each call resets the virtual FS
 * so callers see a pristine engine.
 */
export const JS7z: JS7zFactory = async (options) => {
  const userPrint = options?.print as PrintCb;
  const userPrintErr = options?.printErr as PrintCb;

  let engine = cached;
  if (!engine) {
    // Serialize first-time creation: the MT build spawns a thread pool, and
    // two concurrent JS7z() calls before init completes must share one
    // instance rather than leak a second one.
    if (!initPromise) {
      initPromise = (async (): Promise<CachedEngine> => {
        const create7zz = loadCreate7zz();

        // char-code devices are bound at module init — they must be passed
        // to the factory, not assigned afterwards. `eng` is assigned
        // before any hook can fire (hooks run only during callMain).
        let eng: CachedEngine;
        const stdoutHook = makeAssembler((t) => {
          if (eng.print) eng.print(t);
        });
        const stderrHook = makeAssembler((t) => {
          if (eng.printErr) eng.printErr(t);
        });
        const inst = await create7zz({
          stdout: stdoutHook,
          stderr: stderrHook,
          noInitialRun: true,
        });
        eng = { inst, print: undefined, printErr: undefined, exitCb: null };

        const setPrint = (cb: PrintCb): void => {
          eng.print = cb;
        };
        const setPrintErr = (cb: PrintCb): void => {
          eng.printErr = cb;
        };

        // char-code device → text, delivered to the active callbacks
        Object.defineProperty(inst, "print", {
          configurable: true,
          get: () => eng.print,
          set: setPrint,
        });
        Object.defineProperty(inst, "printErr", {
          configurable: true,
          get: () => eng.printErr,
          set: setPrintErr,
        });

        // onExit fired by the callMain wrapper below
        Object.defineProperty(inst, "onExit", {
          configurable: true,
          get: () => eng.exitCb,
          set: (cb: ((code: number) => void) | null) => {
            eng.exitCb = cb;
          },
        });

        // destroy/_cleanup: shared instance — nothing to free, keep the
        // disposeJS7z call path working (same no-op as js7z-tools had).
        Object.defineProperty(inst, "destroy", {
          configurable: true,
          value: () => undefined,
        });
        Object.defineProperty(inst, "_cleanup", {
          configurable: true,
          value: () => undefined,
        });

        // callMain returns the exit code synchronously on this build; trigger
        // onExit to preserve the Promise flows in run7z / list-core.
        const origCallMain = inst.callMain.bind(inst);
        Object.defineProperty(inst, "callMain", {
          configurable: true,
          value: (args: string[]) => {
            // A synchronous throw means the engine crashed mid-operation
            // (e.g. the worker memory guard OOMs during a print tick). Do NOT
            // fire onExit(1) here: callers treat exit code 1 as a recoverable
            // 7-Zip warning and would silently accept a partial result. The
            // exception propagates to the caller's own try/catch (run7z
            // rejects; direct callMain callers reject via the Promise
            // executor) — the only correct outcome for a crash.
            const code = origCallMain(args);
            if (eng.exitCb) eng.exitCb(code);
            return code;
          },
        });

        cached = eng;
        return eng;
      })().finally(() => {
        initPromise = null;
      });
    }
    engine = await initPromise;
  }

  // rebind callbacks for this call (construction-time contract)
  engine.print = userPrint;
  engine.printErr = userPrintErr;
  engine.exitCb = null;

  // pristine virtual FS for the caller
  resetFS(engine.inst);
  return engine.inst;
};
