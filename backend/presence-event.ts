export type PresenceStatus = 'present' | 'away';

export interface PresenceEvent {
  timestamp: string;
  status: PresenceStatus;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(['present', 'away']);

export function isPresenceEvent(value: unknown): value is PresenceEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === 2 &&
    keys.includes('timestamp') &&
    keys.includes('status') &&
    typeof candidate.timestamp === 'string' &&
    Number.isFinite(Date.parse(candidate.timestamp)) &&
    typeof candidate.status === 'string' &&
    VALID_STATUSES.has(candidate.status)
  );
}
