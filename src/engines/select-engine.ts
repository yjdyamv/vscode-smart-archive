/**
 * Engine selection — Smart Archiver VSCode Extension
 *
 * Host-side decision module: which engine runs a given operation. All the
 * gating that used to be re-implemented at every call site (password leaks
 * to the CLI, wrapped formats, RAR rebuild, system-7z capability probes)
 * lives here behind one small interface — selectEngine returns the choice,
 * callers just dispatch on it. Adding a format or a policy change touches
 * this module only.
 *
 * Host-only by design: the worker never selects an engine, it executes
 * whatever the host decides.
 *
 * @module engines/select-engine
 */

import { hasSystem7z, hasSystem7zForFormat, system7zCanDecompress } from "./system7z";
import { isWrappedFormat } from "../constants";
import { isRarExt } from "../utils/rar";

/** The engine (or orchestration strategy) that should run an operation. */
export type EngineChoice =
  /** System 7z child process (fast path, host thread) */
  | "system7z"
  /** WASM pipeline in the worker thread */
  | "worker"
  /** Native/WASI rar5 binding (compression only — 7-Zip cannot create RAR) */
  | "rar5"
  /** Host-side rebuild orchestration (extract → mutate → recompress → swap) */
  | "rarRebuild";

/** Operations whose engine choice the host must decide. */
export type SelectOp =
  | "compress"
  | "decompress"
  | "list"
  | "isEncrypted"
  | "add"
  | "delete"
  | "rename"
  | "createFolder"
  | "preview";

export interface SelectEngineRequest {
  op: SelectOp;
  /** Format label (compress) or full extension with leading dot (others). */
  ext: string;
  /** Archive password. System 7z receives it via stdin (never argv); WASM keeps it in-process. */
  password?: string;
  /** list: in-memory archive bytes force the worker (no file to read). */
  hasData?: boolean;
  /** decompress: path probed for codec-capability (7z l -slt method check). */
  archivePath?: string;
}

export interface EngineSelection {
  engine: EngineChoice;
  /** Short, log-friendly reason for the choice (never shown to users). */
  reason: string;
}

/**
 * Decide which engine runs the operation. Pure policy — no side effects,
 * no file access beyond cached detection primitives.
 */
export function selectEngine(request: SelectEngineRequest): EngineSelection {
  const { op, ext } = request;

  switch (op) {
    case "compress":
      // RAR5 creation is handled by the rar5 binding — 7-Zip cannot create
      // RAR archives, and the binding keeps passwords in memory.
      // (Compress passes a format label like "rar" without a leading dot.)
      if (isRarFormat(ext)) return { engine: "rar5", reason: "rar-format" };
      // Passwords are piped to system 7z via stdin (never argv), so the
      // native fast path is safe for encrypted archives too.
      if (hasSystem7zForFormat(ext)) {
        return { engine: "system7z", reason: "system7z-available" };
      }
      return { engine: "worker", reason: "no-system7z" };

    case "decompress": {
      // System 7z is kept for encrypted archives: WASM decompression of
      // password-protected files has a known copyDirFromFS issue, and the
      // password is piped via stdin so there is no argv exposure.
      if (hasSystem7zForFormat(ext, true) && system7zCanDecompress(request.archivePath ?? "")) {
        return { engine: "system7z", reason: "system7z-available" };
      }
      return { engine: "worker", reason: "system7z-unsupported-methods" };
    }

    case "list":
      // Wrapped formats always need WASM extraction-based listing (7z l does
      // not traverse the inner tar); in-memory data has no file for 7z.
      if (!isWrappedFormat(ext) && hasSystem7z() && !request.hasData) {
        return { engine: "system7z", reason: "system7z-available" };
      }
      return { engine: "worker", reason: "wrapped-or-in-memory" };

    case "isEncrypted":
      return hasSystem7z()
        ? { engine: "system7z", reason: "system7z-available" }
        : { engine: "worker", reason: "no-system7z" };

    // Mutating an existing archive.
    case "add":
    case "delete":
    case "rename":
      // 7-Zip cannot modify RAR archives (E_NOTIMPL) — rebuild instead.
      if (isRarExt(ext)) return { engine: "rarRebuild", reason: "rar-format" };
      return selectModifyEngine(ext);

    case "createFolder":
      // 7-Zip has no mkdir command, but adding a temp folder with a
      // .smartarchive marker via `7z a` works for non-wrapped formats.
      return isRarExt(ext)
        ? { engine: "rarRebuild", reason: "rar-format" }
        : !isWrappedFormat(ext) && hasSystem7zForFormat(ext)
          ? { engine: "system7z", reason: "system7z-available" }
          : { engine: "worker", reason: "wrapped-or-no-system7z" };

    case "preview":
      // Best-effort fast path: caller tries system 7z and falls back to the
      // worker on failure (brotli/lz4 are not supported by system 7z).
      return hasSystem7zForFormat(ext, true)
        ? { engine: "system7z", reason: "system7z-available" }
        : { engine: "worker", reason: "system7z-unsupported-format" };
  }
}

function selectModifyEngine(ext: string): EngineSelection {
  // Wrapped formats always mutate via WASM (the worker) — the system fast
  // path is only for plain formats.
  if (isWrappedFormat(ext)) return { engine: "worker", reason: "wrapped-format" };
  // Passwords go to system 7z via stdin (never argv), so encrypted
  // mutations can use the native fast path too.
  if (hasSystem7zForFormat(ext)) {
    return { engine: "system7z", reason: "system7z-available" };
  }
  return { engine: "worker", reason: "no-system7z" };
}

/** RAR family: extensions (.rar/.r00–.r99) or the bare "rar" format label. */
function isRarFormat(ext: string): boolean {
  return isRarExt(ext) || ext.toLowerCase() === "rar";
}
