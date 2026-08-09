/**
 * Defaults consistency — Smart Archive VSCode Extension
 *
 * Guards the two places a user-visible default lives: the package.json
 * "configuration" block (settings UI) and the code constants that engine
 * config actually uses (DEFAULT_ENGINE_CONFIG + constants.ts). A setting
 * default changed in one place but not the other silently changes what
 * users see vs. what the engines do — this test turns that drift red.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_ENGINE_CONFIG } from "../src/engines/engine-config";
import {
  DEFAULT_MAX_ARCHIVE_SIZE,
  DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
  DEFAULT_LOG_HISTORY_BYTES,
  WORKER_MEMORY_LIMIT_DEFAULT_MB,
  DEFAULT_COMPRESSION_LEVEL,
} from "../src/constants";
import { parseSize } from "../src/utils/security";

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};

function settingDefault(name: string): unknown {
  const prop = pkg.contributes.configuration.properties[`smart-archive.${name}`];
  if (!prop) throw new Error(`Missing setting smart-archive.${name} in package.json`);
  return prop.default;
}

describe("package.json defaults match code defaults", () => {
  it("defaultCompressionLevel", () => {
    expect(settingDefault("defaultCompressionLevel")).toBe(DEFAULT_COMPRESSION_LEVEL);
    expect(DEFAULT_ENGINE_CONFIG.compressionLevel).toBe(DEFAULT_COMPRESSION_LEVEL);
  });

  it("workerMemoryMb", () => {
    expect(settingDefault("workerMemoryMb")).toBe(WORKER_MEMORY_LIMIT_DEFAULT_MB);
    expect(DEFAULT_ENGINE_CONFIG.workerMemoryMb).toBe(WORKER_MEMORY_LIMIT_DEFAULT_MB);
  });

  it("maxArchiveSize / maxExtractTotalSize", () => {
    expect(parseSize(String(settingDefault("maxArchiveSize")), -1)).toBe(DEFAULT_MAX_ARCHIVE_SIZE);
    expect(parseSize(String(settingDefault("maxExtractTotalSize")), -1)).toBe(
      DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
    );
    expect(DEFAULT_ENGINE_CONFIG.limits.maxArchiveSize).toBe(DEFAULT_MAX_ARCHIVE_SIZE);
    expect(DEFAULT_ENGINE_CONFIG.limits.maxExtractTotalSize).toBe(
      DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
    );
  });

  it("logLevel", () => {
    expect(settingDefault("logLevel")).toBe(DEFAULT_ENGINE_CONFIG.logLevel);
  });

  it("logHistoryBytes", () => {
    expect(settingDefault("logHistoryBytes")).toBe(DEFAULT_LOG_HISTORY_BYTES);
  });

  it("useSystemZstd", () => {
    expect(settingDefault("useSystemZstd")).toBe(DEFAULT_ENGINE_CONFIG.useSystemZstd);
  });

  it("brotliBackend", () => {
    expect(settingDefault("brotliBackend")).toBe(DEFAULT_ENGINE_CONFIG.brotliBackend);
  });

  it("rar5Backend", () => {
    expect(settingDefault("rar5Backend")).toBe(DEFAULT_ENGINE_CONFIG.rar5Backend);
  });

  it("snappyBackend", () => {
    expect(settingDefault("snappyBackend")).toBe(DEFAULT_ENGINE_CONFIG.snappyBackend);
  });
});
