export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function formatUsageCost(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

export function formatFileList(files: string[]): string {
  const listed = files.slice(0, 10).join(', ');
  const remainder = files.length > 10 ? `, and ${files.length - 10} more` : '';
  return `${listed}${remainder}`;
}

export function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated]`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isNonArrayRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

// Sub-percent spend must stay distinguishable from a meter at zero.
export function percentLabel(used: number, cap: number): string {
  const percent = (used / cap) * 100;
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

export function formatShortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
