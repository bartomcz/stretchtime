import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker } from '../frontend/js/presence-tracker.js';

const options = {
  requiredConsecutiveDetections: 3,
  absenceDelayMs: 15_000,
  notificationDelayMs: 30 * 60_000,
};

test('requires three consecutive person detections', () => {
  const tracker = new PresenceTracker(options);
  tracker.recordDetection(true, 1_000);
  tracker.recordDetection(false, 2_000);
  tracker.recordDetection(true, 3_000);
  tracker.recordDetection(true, 4_000);
  assert.equal(tracker.snapshot(4_000).status, 'not-present');

  const event = tracker.recordDetection(true, 5_000);
  assert.equal(event.becamePresent, true);
  assert.equal(tracker.snapshot(5_000).status, 'present');
  assert.equal(tracker.snapshot(5_000).durationMs, 2_000);
});

test('keeps presence during the 15-second absence grace period', () => {
  const tracker = new PresenceTracker(options);
  tracker.recordDetection(true, 0);
  tracker.recordDetection(true, 1_000);
  tracker.recordDetection(true, 2_000);
  tracker.recordDetection(false, 3_000);

  assert.equal(tracker.tick(16_999).becameAbsent, false);
  assert.equal(tracker.snapshot(16_999).status, 'present');
  assert.equal(tracker.tick(17_000).becameAbsent, true);
  assert.equal(tracker.snapshot(17_000).status, 'not-present');
});

test('emits one notification per presence session and resets after absence', () => {
  const tracker = new PresenceTracker(options);
  tracker.recordDetection(true, 0);
  tracker.recordDetection(true, 1_000);
  tracker.recordDetection(true, 2_000);

  assert.equal(tracker.recordDetection(true, 1_799_999).notificationTriggered, false);
  assert.equal(tracker.recordDetection(true, 1_800_000).notificationTriggered, true);
  assert.equal(tracker.recordDetection(true, 1_900_000).notificationTriggered, false);
  assert.equal(tracker.snapshot(1_900_000).notificationSent, true);

  tracker.recordDetection(false, 1_900_000);
  tracker.tick(1_900_000 + 15_000);
  assert.equal(tracker.snapshot(1_915_000).notificationSent, false);
});

test('uses an updated notification delay for the current session', () => {
  const tracker = new PresenceTracker(options);
  tracker.recordDetection(true, 0);
  tracker.recordDetection(true, 1_000);
  tracker.recordDetection(true, 2_000);
  tracker.setNotificationDelayMs(10 * 60_000);

  assert.equal(tracker.recordDetection(true, 599_999).notificationTriggered, false);
  assert.equal(tracker.recordDetection(true, 600_000).notificationTriggered, true);
});
