/**
 * Phase-scoped progress scaling — Smart Archive VSCode Extension
 *
 * Compression pipelines run several phases back to back (e.g. tar
 * packing → codec). Each phase reports its own 0–100% progress; feeding
 * those straight into vscode.Progress would hit 100% mid-pipeline. This
 * wrapper maps a sub-phase's percentage reports into a slice of the
 * overall bar, rewriting both the increment and the "%" message so the
 * bar and the text always show overall progress.
 *
 * vscode-free so it can run in worker threads (js7z-compress-core).
 *
 * @module utils/progress-scale
 */

import type { ProgressLike } from "./cancellation";

export function scaleProgress(prog: ProgressLike, startPct: number, endPct: number): ProgressLike {
  const span = endPct - startPct;
  let overall = startPct;
  let prevOverall = startPct;
  return {
    report(r) {
      const inc = r.increment;
      if (typeof inc === "number" && inc > 0) {
        overall = Math.min(endPct, overall + (inc * span) / 100);
        const sent = Math.round(overall);
        if (sent > Math.round(prevOverall)) {
          prog.report({ message: `${sent}%`, increment: sent - Math.round(prevOverall) });
        }
        prevOverall = overall;
      } else {
        prog.report({ message: r.message });
      }
    },
  };
}
