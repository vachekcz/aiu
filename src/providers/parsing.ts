/** Tolerant helpers for reading unofficial, loosely-typed JSON responses. */

export type JsonRecord = Record<string, unknown>;

export const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function asDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
