/**
 * Log history — Smart Archiver VSCode Extension
 *
 * Byte-budgeted ring buffer of structured log records. The host owns the
 * output panel's rendering (appendLine on a plain OutputChannel), so a
 * level change clears the panel and re-renders it from this buffer in
 * sequence order — the buffer is what makes that rebuild possible.
 *
 * Robustness properties:
 *
 *  - All levels are buffered, so switching the level to ANY level can
 *    re-render the corresponding records.
 *  - A byte budget (not a record count) bounds memory: dense log bursts
 *    cover the same wall-clock window as sparse ones.
 *
 * @module utils/log-history
 */

export interface LogRecord {
  /** pino numeric level (20 = debug … 50 = error) */
  level: number;
  /** Raw pino JSON line, re-emitted verbatim through the channel */
  line: string;
}

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB ≈ thousands of records

export class LogHistory {
  private records: LogRecord[] = [];
  private bytes = 0;

  constructor(private maxBytes: number = DEFAULT_MAX_BYTES) {}

  /** Append a record, evicting the oldest while over budget. */
  push(level: number, line: string): void {
    this.records.push({ level, line });
    this.bytes += Buffer.byteLength(line);
    this.evict();
  }

  /**
   * Deliver every record at or above `minLevel` in sequence order. Used to
   * re-render the whole panel content after a level change, so lines keep
   * their original chronology.
   */
  replayAll(minLevel: number, out: (line: string) => void): void {
    for (const rec of this.records) {
      if (rec.level >= minLevel) {
        out(rec.line);
      }
    }
  }

  /** Drop all buffered records. */
  reset(): void {
    this.records = [];
    this.bytes = 0;
  }

  /**
   * Adjust the byte budget (e.g. from a setting change). Shrinking evicts
   * the oldest records while over the new budget; growing keeps everything.
   */
  setMaxBytes(maxBytes: number): void {
    this.maxBytes = maxBytes;
    this.evict();
  }

  /** Evict the oldest records while over the byte budget. */
  private evict(): void {
    while (this.bytes > this.maxBytes && this.records.length > 0) {
      const dropped = this.records.shift()!;
      this.bytes -= Buffer.byteLength(dropped.line);
    }
  }

  get size(): number {
    return this.records.length;
  }

  get byteSize(): number {
    return this.bytes;
  }
}
