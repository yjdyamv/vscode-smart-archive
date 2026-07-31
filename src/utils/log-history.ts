/**
 * Log history — Smart Archive VSCode Extension
 *
 * Byte-budgeted ring buffer of structured log records, used to replay
 * lines that VS Code's LogOutputChannel hid while its panel level was
 * lower. Robustness properties:
 *
 *  - All levels are buffered, so raising the panel level to ANY level
 *    (Warn→Info, Info→Debug, …) can replay the corresponding history.
 *  - Monotonic sequence numbers keep the replay cursor aligned when the
 *    buffer rolls over — a rolled-out record can never be replayed twice.
 *  - Replay snapshots its end boundary up front: records pushed while a
 *    replay is in flight are NOT part of that replay (they are delivered
 *    live by the regular routing instead), so nothing is duplicated.
 *  - A byte budget (not a record count) bounds memory: dense log bursts
 *    cover the same wall-clock window as sparse ones.
 *
 * @module utils/log-history
 */

export interface LogRecord {
  /** Monotonic sequence number (never reused) */
  seq: number;
  /** pino numeric level (20 = debug … 50 = error) */
  level: number;
  /** Raw pino JSON line, re-emitted verbatim through the channel */
  line: string;
  /**
   * Whether this record was already visible in the panel when it was
   * produced (panel level allowed it). Visible records surface live and
   * must never be replayed — replay is only for lines the panel hid.
   */
  wasVisible: boolean;
}

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB ≈ thousands of records

export class LogHistory {
  private records: LogRecord[] = [];
  private nextSeq = 1;
  private bytes = 0;

  constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

  /** Append a record, evicting the oldest while over budget. */
  push(level: number, line: string, wasVisible = false): void {
    const rec: LogRecord = { seq: this.nextSeq++, level, line, wasVisible };
    this.records.push(rec);
    this.bytes += line.length;
    while (this.bytes > this.maxBytes && this.records.length > 0) {
      const dropped = this.records.shift()!;
      this.bytes -= dropped.line.length;
    }
  }

  /** Latest sequence number (0 when empty). */
  get cursor(): number {
    const last = this.records[this.records.length - 1];
    return last ? last.seq : 0;
  }

  /**
   * Replay records newer than `afterSeq` whose level is at least
   * `minLevel` and which were NOT visible when produced, delivering each
   * through `out`. The end boundary is snapshotted at call time —
   * concurrent pushes are not replayed (they surface live through the
   * normal routing). Returns the new cursor to pass as `afterSeq` next time.
   */
  replayFrom(afterSeq: number, minLevel: number, out: (line: string) => void): number {
    const end = this.records.length;
    for (let i = 0; i < end; i++) {
      const rec = this.records[i];
      if (rec.seq > afterSeq && rec.level >= minLevel && !rec.wasVisible) {
        out(rec.line);
      }
    }
    return this.cursor;
  }

  /** Drop all buffered records and reset the sequence. */
  reset(): void {
    this.records = [];
    this.nextSeq = 1;
    this.bytes = 0;
  }

  get size(): number {
    return this.records.length;
  }

  get byteSize(): number {
    return this.bytes;
  }
}
