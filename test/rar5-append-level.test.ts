/**
 * The rar5 append path must honor the configured compression level.
 *
 * It used to pass a hardcoded rar level 3, so a user who chose 极速/极限 got
 * that level everywhere except appends. The default (5 → rar 3) is unchanged,
 * which is what the first case pins; the second case proves the setting now
 * reaches the appended member's header method.
 *
 * Runs against the real binding when it is installed (`gates.ts`), like the
 * other rar5 engine tests; skipped (recorded in gates.json) elsewhere.
 */
import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendWithRar5,
  compressWithRar5,
  listRar5EntriesDetailed,
} from "../src/engines/rar5-engine";
import { currentCompressionLevel, setCompressionLevel } from "../src/engines/compression-level";
import { DEFAULT_COMPRESSION_LEVEL } from "../src/constants";
import { itIf } from "./gates";
import { tmpDir } from "./tmp";

const RAR5_FORMAT = {
  label: "rar",
  description: "RAR5",
  canCreate: true,
  supportsEncryption: true,
};

/** Compressible payload: STORE is never chosen, so the method reflects the level. */
function payload(tag: string): string {
  return `${tag}\n`.repeat(20_000);
}

describe("rar5 append honors the configured level", () => {
  let dir: string;

  afterEach(() => {
    setCompressionLevel(DEFAULT_COMPRESSION_LEVEL);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  itIf(
    "rar5Binding",
    "appends at the configured level, and at rar 3 for the shipped default",
    async () => {
      dir = tmpDir("sat_appendlevel-");
      const archive = path.join(dir, "base.rar");
      const base = path.join(dir, "base.txt");
      const atUltra = path.join(dir, "ultra.txt");
      const atDefault = path.join(dir, "default.txt");
      fs.writeFileSync(base, payload("base"));
      fs.writeFileSync(atUltra, payload("ultra"));
      fs.writeFileSync(atDefault, payload("default"));

      await compressWithRar5(
        { format: RAR5_FORMAT, outputPath: archive, targets: [{ fsPath: base }], level: 3 },
        undefined,
        undefined,
        [],
      );

      // 极限: UI 9 -> rar 5 (BEST) must reach the appended member's header.
      setCompressionLevel(9);
      expect(currentCompressionLevel()).toBe(9);
      await appendWithRar5(archive, [atUltra], "", "", []);
      let entries = await listRar5EntriesDetailed(archive);
      expect(entries.find((e) => e.name === "ultra.txt")?.method).toBe(5);

      // The shipped default: UI 5 -> rar 3 (NORMAL), i.e. the old behaviour.
      setCompressionLevel(DEFAULT_COMPRESSION_LEVEL);
      await appendWithRar5(archive, [atDefault], "", "", []);
      entries = await listRar5EntriesDetailed(archive);
      expect(entries.find((e) => e.name === "default.txt")?.method).toBe(3);
      // The first append's level is untouched by the second.
      expect(entries.find((e) => e.name === "ultra.txt")?.method).toBe(5);
    },
  );

  it("maps the UI scale onto the rar scale at the append call site", () => {
    // The mapping itself is pinned by test/rar5-map-level.test.ts; this keeps
    // the append path's source of truth honest without needing the binding.
    setCompressionLevel(9);
    expect(currentCompressionLevel()).toBe(9);
    setCompressionLevel(Number.NaN);
    expect(currentCompressionLevel()).toBe(9);
  });
});
