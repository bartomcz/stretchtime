const DEFAULTS = Object.freeze({
  requiredConsecutiveDetections: 3,
  absenceDelayMs: 15_000,
  notificationDelayMs: 30 * 60_000,
});

/**
 * Turns noisy one-frame detections into a stable presence session.
 * It has no browser dependencies, which keeps the timing rules testable.
 */
export class PresenceTracker {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.status = 'not-present';
    this.consecutiveDetections = 0;
    this.candidateStartedAt = null;
    this.presenceStartedAt = null;
    this.lastSeenAt = null;
    this.personDetected = false;
    this.notificationSent = false;
  }

  recordDetection(personDetected, now = Date.now()) {
    this.personDetected = personDetected;
    let becamePresent = false;

    if (personDetected) {
      if (this.status === 'present') {
        this.lastSeenAt = now;
      } else {
        if (this.consecutiveDetections === 0) this.candidateStartedAt = now;
        this.consecutiveDetections += 1;

        if (
          this.consecutiveDetections >=
          this.options.requiredConsecutiveDetections
        ) {
          this.status = 'present';
          this.presenceStartedAt = this.candidateStartedAt;
          this.lastSeenAt = now;
          this.consecutiveDetections = 0;
          this.candidateStartedAt = null;
          becamePresent = true;
        }
      }
    } else if (this.status === 'not-present') {
      this.consecutiveDetections = 0;
      this.candidateStartedAt = null;
    }

    return this.tick(now, { becamePresent });
  }

  setNotificationDelayMs(notificationDelayMs) {
    if (!Number.isFinite(notificationDelayMs) || notificationDelayMs <= 0) {
      throw new RangeError('Notification delay must be a positive number.');
    }
    this.options.notificationDelayMs = notificationDelayMs;
  }

  tick(now = Date.now(), events = {}) {
    let becameAbsent = false;
    let notificationTriggered = false;

    if (
      this.status === 'present' &&
      now - this.lastSeenAt >= this.options.absenceDelayMs
    ) {
      this.status = 'not-present';
      this.presenceStartedAt = null;
      this.lastSeenAt = null;
      this.personDetected = false;
      this.notificationSent = false;
      this.consecutiveDetections = 0;
      this.candidateStartedAt = null;
      becameAbsent = true;
    }

    if (
      this.status === 'present' &&
      !this.notificationSent &&
      now - this.presenceStartedAt >= this.options.notificationDelayMs
    ) {
      this.notificationSent = true;
      notificationTriggered = true;
    }

    return {
      becamePresent: Boolean(events.becamePresent),
      becameAbsent,
      notificationTriggered,
    };
  }

  snapshot(now = Date.now()) {
    return {
      status: this.status,
      durationMs:
        this.status === 'present' ? Math.max(0, now - this.presenceStartedAt) : 0,
      notificationSent: this.notificationSent,
      personDetected: this.personDetected,
    };
  }
}

export const presenceDefaults = DEFAULTS;
