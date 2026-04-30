/**
 * Formatting utilities — Smart Archive VSCode Extension
 *
 * Pure formatting functions with no locale dependency.
 *
 * @module utils/format
 */

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatCompactSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

export { formatDuration, formatCompactSize };
