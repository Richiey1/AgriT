import type { ActivityEntry } from '../types/vyc.types.js';

// USSD/mobile gateway event types (issue #6). Deliberately narrow — the
// scoring service ignores unknown types anyway, but we reject them at the
// door so garbage never reaches the score.
const ALLOWED_ACTIVITY_TYPES = ['planting', 'harvest', 'sale', 'purchase'] as const;

/** Strict YYYY-MM-DD calendar-date check (rejects 08/01/2026, 2026, 2026-13-40). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export type ActivityType = (typeof ALLOWED_ACTIVITY_TYPES)[number];

export function isAllowedActivityType(type: string): type is ActivityType {
  return (ALLOWED_ACTIVITY_TYPES as readonly string[]).includes(type);
}

interface StoredActivity extends ActivityEntry {
  id: number;
  farmerId: string;
}

// In-memory store for now — no persistence layer exists in this repo yet.
// The scoring service consumes plain ActivityEntry[] so swapping in a real
// database later only touches this file.
const store = new Map<string, StoredActivity[]>();
let nextId = 1;

export interface LogActivityResult {
  id: number;
}

/** Logs one activity event for a farmer. Type must pass the allowlist first. */
export function logActivity(
  farmerId: string,
  type: ActivityType,
  date: string,
  amount = 0
): LogActivityResult {
  const entry: StoredActivity = {
    id: nextId++,
    farmerId,
    type,
    amount,
    timestamp: Math.floor(new Date(date).getTime() / 1000),
    region: '',
  };

  const existing = store.get(farmerId) ?? [];
  existing.push(entry);
  store.set(farmerId, existing);

  return { id: entry.id };
}

/** All stored events for one farmer, oldest first (scoring input shape). */
export function getActivitiesForFarmer(farmerId: string): ActivityEntry[] {
  return (store.get(farmerId) ?? []).map(({ type, amount, timestamp, region }) => ({
    type,
    amount,
    timestamp,
    region,
  }));
}
