export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
