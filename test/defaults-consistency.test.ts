/**
 * Defaults consistency — Smart Archiver VSCode Extension
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
  const prop = pkg.contributes.configuration.properties[`smart-archiver.${name}`];
  if (!prop) throw new Error(`Missing setting smart-archiver.${name} in package.json`);
  return prop.default;
}

describe("package.json defaults match code defaults", () => {
  it("default.compressionLevel", () => {
    expect(settingDefault("default.compressionLevel")).toBe(DEFAULT_COMPRESSION_LEVEL);
    expect(DEFAULT_ENGINE_CONFIG.compressionLevel).toBe(DEFAULT_COMPRESSION_LEVEL);
  });

  it("worker.memoryMb", () => {
    expect(settingDefault("worker.memoryMb")).toBe(WORKER_MEMORY_LIMIT_DEFAULT_MB);
    expect(DEFAULT_ENGINE_CONFIG.workerMemoryMb).toBe(WORKER_MEMORY_LIMIT_DEFAULT_MB);
  });

  it("limits.maxArchiveSize / maxExtractTotalSize", () => {
    expect(parseSize(String(settingDefault("limits.maxArchiveSize")), -1)).toBe(DEFAULT_MAX_ARCHIVE_SIZE);
    expect(parseSize(String(settingDefault("limits.maxExtractTotalSize")), -1)).toBe(
      DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
    );
    expect(DEFAULT_ENGINE_CONFIG.limits.maxArchiveSize).toBe(DEFAULT_MAX_ARCHIVE_SIZE);
    expect(DEFAULT_ENGINE_CONFIG.limits.maxExtractTotalSize).toBe(
      DEFAULT_MAX_EXTRACT_TOTAL_SIZE,
    );
  });

  it("log.level", () => {
    expect(settingDefault("log.level")).toBe(DEFAULT_ENGINE_CONFIG.logLevel);
  });

  it("log.historyBytes", () => {
    expect(settingDefault("log.historyBytes")).toBe(DEFAULT_LOG_HISTORY_BYTES);
  });

  it("backend.7z", () => {
    expect(settingDefault("backend.7z")).toBe(DEFAULT_ENGINE_CONFIG.sevenZBackend);
  });

  it("backend.zstd", () => {
    expect(settingDefault("backend.zstd")).toBe(DEFAULT_ENGINE_CONFIG.zstdBackend);
  });

  it("backend.brotli", () => {
    expect(settingDefault("backend.brotli")).toBe(DEFAULT_ENGINE_CONFIG.brotliBackend);
  });

  it("backend.lz4", () => {
    expect(settingDefault("backend.lz4")).toBe(DEFAULT_ENGINE_CONFIG.lz4Backend);
  });

  it("backend.rar", () => {
    expect(settingDefault("backend.rar")).toBe(DEFAULT_ENGINE_CONFIG.rar5Backend);
  });

  it("backend.snappy", () => {
    expect(settingDefault("backend.snappy")).toBe(DEFAULT_ENGINE_CONFIG.snappyBackend);
  });

  it("backend.tar", () => {
    expect(settingDefault("backend.tar")).toBe(DEFAULT_ENGINE_CONFIG.tarBackend);
  });
});
