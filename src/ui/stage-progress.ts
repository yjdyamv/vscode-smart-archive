/**
 * Per-stage progress notifications — Smart Archive VSCode Extension
 *
 * Compression pipelines run copy → pack → compress stages. Each stage gets
 * its own progress notification (own bar, own elapsed timer), but only one
 * notification is visible at a time: when a stage finishes its notification
 * closes and the next stage's opens. This gives users per-stage visibility
 * without flooding the notification area.
 *
 * @module ui/stage-progress
 */

import * as vscode from "vscode";
import { t } from "../i18n";
import type { ProgressStage } from "../utils/cancellation";

export type { ProgressStage } from "../utils/cancellation";

export interface StageProgressReport {
  stage?: ProgressStage;
  message?: string;
  increment?: number;
}

export interface StageDuration {
  stage: ProgressStage;
  ms: number;
}

const STAGE_TITLE_KEYS: Record<ProgressStage, string> = {
  copy: "compress.stage.copy",
  pack: "compress.stage.pack",
  compress: "compress.stage.compress",
  append: "compress.stage.append",
};

/**
 * Routes stage-tagged engine progress to one notification per stage.
 *
 * The exposed `progress` object is a vscode.Progress, so engines keep their
 * usual report contract; reports without a stage are forwarded to the
 * currently open notification and ignored before the first stage starts.
 */
export class StageProgress {
  private readonly cts = new vscode.CancellationTokenSource();
  private activeStage?: ProgressStage;
  private activeProgress?: vscode.Progress<{ message?: string; increment?: number }>;
  private closeActive?: () => void;
  private activeWindow?: Thenable<void>;
  private readonly startedAt = new Map<ProgressStage, number>();
  private readonly durations = new Map<ProgressStage, number>();
  private readonly lastPct = new Map<ProgressStage, number>();
  private disposed = false;

  readonly token: vscode.CancellationToken;
  readonly progress: vscode.Progress<StageProgressReport>;

  constructor() {
    this.token = this.cts.token;
    this.progress = { report: (r) => this.report(r) };
  }

  report(report: StageProgressReport): void {
    if (this.disposed) return;
    const stage = report.stage ?? this.activeStage;
    if (stage && stage !== this.activeStage) this.switchStage(stage);
    // Reports before any stage opens (e.g. engine init) are intentionally
    // dropped so no notification appears for bookkeeping work.
    if (!this.activeProgress || !stage) return;
    const pctMatch = report.message?.match(/^(\d{1,3})%$/);
    if (!pctMatch) {
      this.activeProgress.report({ message: report.message, increment: report.increment });
      return;
    }
    // Engines may emit out-of-order percentages across volumes; clamp each
    // stage's bar to monotonic 0–100% so it never jumps backwards.
    const pct = Math.min(100, parseInt(pctMatch[1], 10));
    const prev = this.lastPct.get(stage) ?? 0;
    if (pct <= prev || pct <= 0) return;
    this.lastPct.set(stage, pct);
    this.activeProgress.report({ message: `${pct}%`, increment: pct - prev });
  }

  stageDurations(): StageDuration[] {
    const out: StageDuration[] = [];
    for (const [stage, ms] of this.durations) out.push({ stage, ms });
    if (this.activeStage && this.startedAt.has(this.activeStage)) {
      out.push({
        stage: this.activeStage,
        ms: Date.now() - this.startedAt.get(this.activeStage)!,
      });
    }
    return out;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.closeWindow();
    this.cts.dispose();
  }

  private switchStage(stage: ProgressStage): void {
    void this.closeWindow();
    this.activeStage = stage;
    if (!this.startedAt.has(stage)) this.startedAt.set(stage, Date.now());
    this.activeWindow = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t(STAGE_TITLE_KEYS[stage]),
        cancellable: true,
      },
      (progress, token) => {
        this.activeProgress = progress;
        token?.onCancellationRequested?.(() => this.cts.cancel());
        return new Promise<void>((resolve) => {
          this.closeActive = resolve;
        });
      },
    );
  }

  private async closeWindow(): Promise<void> {
    const close = this.closeActive;
    const window = this.activeWindow;
    this.closeActive = undefined;
    this.activeWindow = undefined;
    this.activeProgress = undefined;
    if (this.activeStage && this.startedAt.has(this.activeStage)) {
      this.durations.set(this.activeStage, Date.now() - this.startedAt.get(this.activeStage)!);
      this.activeStage = undefined;
    }
    close?.();
    if (window) await Promise.resolve(window).catch(() => {});
  }
}
