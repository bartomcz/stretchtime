export const OFFLINE_AFTER_MS = 90_000;

/**
 * Converts heartbeat events into contiguous presence, away, and offline ranges.
 * A status remains known until another event arrives or its heartbeat expires.
 */
export function createTimelineSegments(
  events,
  startMs,
  endMs,
  offlineAfterMs = OFFLINE_AFTER_MS,
) {
  if (!(startMs < endMs) || offlineAfterMs <= 0) return [];

  const orderedEvents = events
    .map((event) => ({ ...event, timeMs: Date.parse(event.timestamp) }))
    .filter(
      (event) =>
        Number.isFinite(event.timeMs) &&
        (event.status === 'present' || event.status === 'away') &&
        event.timeMs < endMs,
    )
    .sort((left, right) => left.timeMs - right.timeMs);

  const segments = [];
  const append = (status, segmentStart, segmentEnd) => {
    const clippedStart = Math.max(startMs, segmentStart);
    const clippedEnd = Math.min(endMs, segmentEnd);
    if (clippedStart >= clippedEnd) return;

    const previous = segments.at(-1);
    if (previous?.status === status && previous.endMs === clippedStart) {
      previous.endMs = clippedEnd;
    } else {
      segments.push({ status, startMs: clippedStart, endMs: clippedEnd });
    }
  };

  let previousEvent;
  for (const event of orderedEvents) {
    if (previousEvent) {
      const knownUntil = Math.min(event.timeMs, previousEvent.timeMs + offlineAfterMs);
      append(previousEvent.status, previousEvent.timeMs, knownUntil);
      append('offline', knownUntil, event.timeMs);
    } else {
      append('offline', startMs, event.timeMs);
    }
    previousEvent = event;
  }

  if (previousEvent) {
    const knownUntil = Math.min(endMs, previousEvent.timeMs + offlineAfterMs);
    append(previousEvent.status, previousEvent.timeMs, knownUntil);
    append('offline', knownUntil, endMs);
  } else {
    append('offline', startMs, endMs);
  }

  return segments;
}
