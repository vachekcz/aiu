/** Tolerant helpers for reading unofficial, loosely-typed JSON responses. */

import type { LimitKind } from '../types.ts';

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

const WEEK_SECONDS = 604_800;

/** A rolling window as a column label: "5h", "1d", "Week". */
export function windowLabel(seconds: number): string {
  if (seconds === WEEK_SECONDS) return 'Week';
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** A window of a week or longer is the weekly allowance; anything shorter is the short rolling one. */
export const windowKind = (seconds: number): LimitKind => (seconds >= WEEK_SECONDS ? 'weekly' : 'session');
