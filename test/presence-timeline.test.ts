import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTimelineSegments,
  OFFLINE_AFTER_MS,
  type TimelineEvent,
} from '../frontend/js/presence-timeline.js';

const minute = 60_000;
const start = Date.parse('2026-07-14T00:00:00.000Z');

function event(offsetMinutes: number, status: 'present' | 'away'): TimelineEvent {
  return { timestamp: new Date(start + offsetMinutes * minute).toISOString(), status };
}

test('marks time without heartbeats as offline', () => {
  assert.deepEqual(createTimelineSegments([], start, start + 10 * minute), [
    { status: 'offline', startMs: start, endMs: start + 10 * minute },
  ]);
});

test('keeps status alive across heartbeats and marks an expired gap offline', () => {
  const segments = createTimelineSegments(
    [event(1, 'present'), event(2, 'present'), event(5, 'away')],
    start,
    start + 7 * minute,
  );

  assert.deepEqual(segments, [
    { status: 'offline', startMs: start, endMs: start + minute },
    { status: 'present', startMs: start + minute, endMs: start + 2 * minute + OFFLINE_AFTER_MS },
    { status: 'offline', startMs: start + 2 * minute + OFFLINE_AFTER_MS, endMs: start + 5 * minute },
    { status: 'away', startMs: start + 5 * minute, endMs: start + 5 * minute + OFFLINE_AFTER_MS },
    {
      status: 'offline',
      startMs: start + 5 * minute + OFFLINE_AFTER_MS,
      endMs: start + 7 * minute,
    },
  ]);
});

test('uses a recent event before midnight as the initial status', () => {
  const segments = createTimelineSegments(
    [{ timestamp: new Date(start - 30_000).toISOString(), status: 'present' }],
    start,
    start + 2 * minute,
  );

  assert.deepEqual(segments, [
    { status: 'present', startMs: start, endMs: start + minute },
    { status: 'offline', startMs: start + minute, endMs: start + 2 * minute },
  ]);
});
