/**
 * Log event naming — Smart Archive VSCode Extension
 *
 * Guards the event naming convention documented in utils/logger-core.ts:
 *
 *   namespace.action[.result]  — dotted, lowercase-first segments,
 *   result in {start, done, ok, failed, cancelled, skip, warn}
 *
 * Forbidden final segments: error / complete / success / enter / exit.
 * A single-segment event name ("message", "setCopiedPaths") is also a
 * violation. Scans src/ for every `event: "..."` literal — drift fails CI.
 */

import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/** Matches `event: "..."` string literals (possibly multiline calls). */
const EVENT_LITERAL = /event:\s*"([^"]+)"/g;

const FORBIDDEN_RESULT = new Set(["error", "complete", "success", "enter", "exit"]);

const VALID_RESULT = new Set([
  "start",
  "done",
  "ok",
  "failed",
  "cancelled",
  "skip",
  "warn",
]);

const SEGMENT = /^[a-zA-Z0-9]+$/;

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(path.join(__dirname, "..", "src"));
  return out;
}

interface Violation {
  file: string;
  event: string;
  problem: string;
}

describe("log event naming convention", () => {
  const violations: Violation[] = [];

  for (const file of srcFiles()) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(EVENT_LITERAL)) {
      const event = match[1];
      // Skip non-log usages: the worker port API (on(event: "message", …))
      // and doc-comment placeholders like "<namespace>.<action>".
      if (content.slice(Math.max(0, match.index - 12), match.index).trimEnd().endsWith("on(")) {
        continue;
      }
      if (/[<>]/.test(event)) continue;
      const segments = event.split(".");
      const last = segments[segments.length - 1];

      if (segments.length < 2) {
        violations.push({
          file,
          event,
          problem: "single-segment event — needs a namespace prefix",
        });
        continue;
      }
      if (!SEGMENT.test(segments[0]) || segments[0][0] !== segments[0][0]!.toLowerCase()) {
        violations.push({ file, event, problem: "namespace segment must start lowercase" });
        continue;
      }
      for (const seg of segments) {
        if (!SEGMENT.test(seg)) {
          violations.push({ file, event, problem: `segment "${seg}" has invalid characters` });
          break;
        }
      }
      if (FORBIDDEN_RESULT.has(last)) {
        violations.push({
          file,
          event,
          problem: `forbidden result suffix ".${last}" — use .ok/.failed instead`,
        });
      } else if (VALID_RESULT.has(last)) {
        // fine
      }
    }
  }

  it("every event name follows namespace.action[.result]", () => {
    expect(
      violations.map((v) => `${v.file.replace(/^.*\/src/, "src")}: ${v.event} — ${v.problem}`),
    ).toEqual([]);
  });
});
