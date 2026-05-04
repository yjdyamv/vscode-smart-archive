/**
 * Shared type definitions — 7z VSCode Extension
 *
 * Interfaces and type aliases used across all modules to ensure type safety.
 *
 * @module types/index
 */

/** Metadata for a supported archive format */
export interface FormatInfo {
  /** File extension label (e.g. '7z', 'zip', 'rar') */
  label: string;
  /** Human-readable description shown in the format picker */
  description: string;
  /** Whether this format supports creation (compression). RAR is extraction-only */
  canCreate: boolean;
  /** Whether this format supports AES encryption */
  supportsEncryption: boolean;
}

/**
 * Password prompt result:
 * - string: user provided a password
 * - null: user cancelled the dialog
 * - '': user chose to skip (no password)
 */
export type PasswordResult = string | null;

/**
 * Encryption choice result:
 * - true: user chose to encrypt
 * - false: user chose not to encrypt
 * - null: user cancelled
 */
export type EncryptChoice = boolean | null;

/** Input parameters for a compression operation */
export interface CompressOptions {
  /** File/folder URIs to compress */
  targets: readonly { fsPath: string }[];
  /** Target archive format */
  format: FormatInfo;
  /** Output file path */
  outputPath: string;
  /** AES encryption password (empty string = no encryption) */
  password: string;
  /** 7-Zip compression level (0=store, 1=fastest, 3=fast, 5=normal, 7=max, 9=ultra) */
  level: number;
  /** Split archive into volumes of this size (e.g. "100m", "650m", "1g"). Unset = no split. */
  volumeSize?: string;
}

/** Input parameters for a decompression operation */
export interface DecompressOptions {
  /** Path to the archive file */
  inputPath: string;
  /** Output directory for extracted files */
  outputDir: string;
  /** Decryption password (empty string = not encrypted) */
  password: string;
}

/**
 * Simplified interface for a js7z-tools instance.
 * js7z-tools is an Emscripten port of 7-Zip; `JS7z()` returns
 * an object with an Emscripten-style virtual file system and CLI runner.
 */
export interface JS7zInstance {
  /** Run a 7z command (arguments mirror the CLI) */
  callMain(args: string[]): void;
  /** Exit callback — receives the 7z process exit code (0 = success) */
  onExit: ((exitCode: number) => void) | null;
  /** stdout callback */
  print?: (text: string) => void;
  /** stderr callback */
  printErr?: (text: string) => void;
  /** Abort callback */
  onAbort?: (reason: string) => void;
  /** Release WASM resources */
  destroy?: () => void;
  /** Emscripten internal cleanup (fallback) */
  _cleanup?: () => void;
  /** Emscripten virtual file system */
  FS: EmscriptenFS;
  /** NODEFS backend for mounting local directories */
  NODEFS: unknown;
}

/**
 * Emscripten virtual file system API (subset used by this extension).
 */
export interface EmscriptenFS {
  mkdir(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, options?: { encoding: "binary" }): ArrayBuffer;
  readdir(path: string): string[];
  stat(path: string): { mode: number; size: number };
  isDir(mode: number): boolean;
  mount(type: unknown, opts: { root: string }, mountPoint: string): void;
  symlink(target: string, path: string): void;
  createDataFile(
    parent: string,
    name: string,
    data: Uint8Array,
    canRead: boolean,
    canWrite: boolean,
    canOwn?: number,
  ): void;
  open(path: string, flags: string): unknown;
  write(
    stream: unknown,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): void;
  close(stream: unknown): void;
}

/** js7z-tools factory function signature */
export type JS7zFactory = (options?: Record<string, unknown>) => Promise<JS7zInstance>;
