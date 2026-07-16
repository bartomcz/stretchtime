const VALID_STATUSES = new Set(['present', 'away']);

export function isPresenceEvent(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes('timestamp') &&
    keys.includes('status') &&
    typeof value.timestamp === 'string' &&
    Number.isFinite(Date.parse(value.timestamp)) &&
    VALID_STATUSES.has(value.status)
  );
}
