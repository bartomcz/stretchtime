import type { DetectedObject, ObjectDetection } from '@tensorflow-models/coco-ssd';
import {
  PresenceTracker,
  presenceDefaults,
  type PresenceTrackerEvents,
} from './presence-tracker.js';
import {
  createTimelineSegments,
  OFFLINE_AFTER_MS,
  type TimelineEvent,
  type TimelineStatus,
} from './presence-timeline.js';

declare global {
  interface Window {
    tf: typeof import('@tensorflow/tfjs');
    cocoSsd: typeof import('@tensorflow-models/coco-ssd');
  }
}

const DETECTION_INTERVAL_MS = 1_000;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
const PERSON_SCORE_THRESHOLD = 0.55;
const NOTIFICATION_DELAY_STORAGE_KEY = 'stretchtime.notificationDelayMinutes';
const DEFAULT_NOTIFICATION_DELAY_MINUTES = presenceDefaults.notificationDelayMs / 60_000;
let notificationDelayMinutes = loadNotificationDelayMinutes();
const tracker = new PresenceTracker({
  notificationDelayMs: notificationDelayMinutes * 60_000,
});

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const elements = {
  camera: requireElement<HTMLVideoElement>('#camera'),
  overlay: requireElement<HTMLCanvasElement>('#overlay'),
  placeholder: requireElement<HTMLElement>('#camera-placeholder'),
  modelState: requireElement<HTMLElement>('#model-state'),
  detectionState: requireElement<HTMLElement>('#detection-state'),
  statusCard: requireElement<HTMLElement>('#status-card'),
  presenceStatus: requireElement<HTMLElement>('#presence-status'),
  statusDetail: requireElement<HTMLElement>('#status-detail'),
  presenceDuration: requireElement<HTMLElement>('#presence-duration'),
  notificationStatus: requireElement<HTMLElement>('#notification-status'),
  notificationDelay: requireElement<HTMLInputElement>('#notification-delay'),
  notificationDelayUnit: requireElement<HTMLElement>('#notification-delay-unit'),
  notificationDetail: requireElement<HTMLElement>('#notification-detail'),
  notificationMessage: requireElement<HTMLElement>('#notification-message'),
  startButton: requireElement<HTMLButtonElement>('#start-button'),
  errorMessage: requireElement<HTMLElement>('#error-message'),
  notificationBanner: requireElement<HTMLElement>('#notification-banner'),
  dismissNotification: requireElement<HTMLButtonElement>('#dismiss-notification'),
  connectionDot: requireElement<HTMLElement>('#connection-dot'),
  connectionText: requireElement<HTMLElement>('#connection-text'),
  timeline: requireElement<HTMLElement>('#presence-timeline'),
  timelineSegments: requireElement<HTMLElement>('#timeline-segments'),
  timelineNow: requireElement<HTMLElement>('#timeline-now'),
  timelineDate: requireElement<HTMLElement>('#timeline-date'),
  presentTotal: requireElement<HTMLElement>('#present-total'),
  awayTotal: requireElement<HTMLElement>('#away-total'),
  offlineTotal: requireElement<HTMLElement>('#offline-total'),
  timelineMessage: requireElement<HTMLElement>('#timeline-message'),
};

let model: ObjectDetection | undefined;
let mediaStream: MediaStream | undefined;
let monitoring = false;
let systemNotification: Notification | undefined;
let presenceHeartbeatTimer: number | undefined;
let timelineEvents: TimelineEvent[] = [];
let timelineDayStart: number | undefined;
let timelineRequestId = 0;

function loadNotificationDelayMinutes(): number {
  try {
    const savedMinutes = Number(localStorage.getItem(NOTIFICATION_DELAY_STORAGE_KEY));
    return Number.isSafeInteger(savedMinutes) && savedMinutes > 0
      ? savedMinutes
      : DEFAULT_NOTIFICATION_DELAY_MINUTES;
  } catch {
    return DEFAULT_NOTIFICATION_DELAY_MINUTES;
  }
}

function saveNotificationDelayMinutes(minutes: number): void {
  try {
    localStorage.setItem(NOTIFICATION_DELAY_STORAGE_KEY, String(minutes));
  } catch {
    // The setting still applies for this page when storage is unavailable.
  }
}

function formatNotificationDelay(minutes: number): string {
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function updateNotificationDelayCopy(): void {
  const delay = formatNotificationDelay(notificationDelayMinutes);
  elements.notificationDelay.value = String(notificationDelayMinutes);
  elements.notificationDelayUnit.textContent = notificationDelayMinutes === 1 ? 'minute' : 'minutes';
  elements.notificationDetail.textContent = `One alert after ${delay} per session. Changes apply immediately.`;
  elements.notificationMessage.textContent = `You have been present for ${delay}.`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function getDayBounds(now = new Date()): { startMs: number; endMs: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function formatTimelineDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (totalMinutes === 0) return milliseconds > 0 ? '<1m' : '0m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderTimeline(nowMs = Date.now()): void {
  const { startMs, endMs } = getDayBounds(new Date(nowMs));
  if (timelineDayStart !== startMs) {
    refreshTimeline();
    return;
  }

  const elapsedEnd = Math.min(Math.max(nowMs, startMs), endMs);
  const dayDuration = endMs - startMs;
  const segments = createTimelineSegments(timelineEvents, startMs, elapsedEnd);
  const totals: Record<TimelineStatus, number> = { present: 0, away: 0, offline: 0 };
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  const segmentElements = segments.map((segment) => {
    totals[segment.status] += segment.endMs - segment.startMs;
    const element = document.createElement('span');
    element.className = `timeline-segment is-${segment.status}`;
    element.style.left = `${((segment.startMs - startMs) / dayDuration) * 100}%`;
    element.style.width = `${((segment.endMs - segment.startMs) / dayDuration) * 100}%`;
    const statusLabel = `${segment.status.charAt(0).toUpperCase()}${segment.status.slice(1)}`;
    element.title =
      `${statusLabel} · ${timeFormatter.format(segment.startMs)}` +
      `–${timeFormatter.format(segment.endMs)}`;
    return element;
  });

  elements.timelineSegments.replaceChildren(...segmentElements);
  elements.timelineNow.style.left = `${((elapsedEnd - startMs) / dayDuration) * 100}%`;
  elements.timelineDate.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(startMs);
  elements.presentTotal.textContent = formatTimelineDuration(totals.present);
  elements.awayTotal.textContent = formatTimelineDuration(totals.away);
  elements.offlineTotal.textContent = formatTimelineDuration(totals.offline);
  elements.timeline.setAttribute(
    'aria-label',
    `Today's presence timeline. Present ${elements.presentTotal.textContent}, away ${elements.awayTotal.textContent}, offline ${elements.offlineTotal.textContent}.`,
  );
}

async function refreshTimeline(): Promise<void> {
  const requestId = ++timelineRequestId;
  const { startMs, endMs } = getDayBounds();
  const query = new URLSearchParams({
    // Include enough context to determine whether a heartbeat crosses midnight.
    from: new Date(startMs - OFFLINE_AFTER_MS).toISOString(),
    to: new Date(endMs).toISOString(),
  });

  try {
    const response = await fetch(`/api/events?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (
      payload === null ||
      typeof payload !== 'object' ||
      !Array.isArray((payload as { events?: unknown }).events)
    ) {
      throw new Error('Invalid history response');
    }
    if (requestId !== timelineRequestId) return;

    timelineEvents = (payload as { events: TimelineEvent[] }).events;
    timelineDayStart = startMs;
    elements.timelineMessage.textContent = '';
    renderTimeline();
  } catch (error) {
    if (requestId !== timelineRequestId) return;
    console.error('Could not load presence history:', error);
    elements.timelineMessage.textContent = 'History unavailable';
  }
}

function render(now = Date.now()): void {
  const snapshot = tracker.snapshot(now);
  const isPresent = snapshot.status === 'present';

  elements.presenceStatus.textContent = isPresent ? 'Present' : 'Not Present';
  elements.statusCard.classList.toggle('is-present', isPresent);
  elements.statusCard.classList.toggle('is-absent', !isPresent);
  elements.presenceDuration.textContent = formatDuration(snapshot.durationMs);

  if (!monitoring) {
    elements.statusDetail.textContent = 'Start monitoring to begin.';
  } else if (isPresent && snapshot.personDetected) {
    elements.statusDetail.textContent = 'Person detected in the latest frame.';
  } else if (isPresent) {
    const remaining = Math.max(
      0,
      Math.ceil(
        (presenceDefaults.absenceDelayMs - (now - (tracker.lastSeenAt ?? now))) / 1_000,
      ),
    );
    elements.statusDetail.textContent = `No current detection · ${remaining}s grace remaining.`;
  } else if (tracker.consecutiveDetections > 0) {
    elements.statusDetail.textContent =
      `Confirming presence · ${tracker.consecutiveDetections}/${presenceDefaults.requiredConsecutiveDetections}`;
  } else {
    elements.statusDetail.textContent = 'Waiting for a person.';
  }

  if (snapshot.notificationSent) {
    elements.notificationStatus.textContent = 'Sent for this session';
  } else if (isPresent) {
    const remaining = Math.max(0, notificationDelayMinutes * 60_000 - snapshot.durationMs);
    elements.notificationStatus.textContent = `Waiting · ${formatDuration(remaining)}`;
  } else {
    elements.notificationStatus.textContent = 'Ready';
  }
}

function triggerNotification(): void {
  elements.notificationBanner.hidden = false;

  if ('Notification' in window && Notification.permission === 'granted') {
    // This branch is reached only once because PresenceTracker latches the session event.
    systemNotification = new Notification('Time to stretch', {
      body: `You have been continuously present for ${formatNotificationDelay(notificationDelayMinutes)}.`,
      tag: 'stretchtime-session',
      renotify: false,
    } as NotificationOptions & { renotify: boolean });
  }
}

function handleTrackerEvents(events: PresenceTrackerEvents): void {
  if (events.notificationTriggered) triggerNotification();
  if (events.becameAbsent) {
    elements.notificationBanner.hidden = true;
    systemNotification?.close();
    systemNotification = undefined;
  }
  if (events.becamePresent || events.becameAbsent) {
    sendPresenceEvent();
  }
}

function drawPredictions(predictions: DetectedObject[]): void {
  const canvas = elements.overlay;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the camera overlay context.');

  canvas.width = elements.camera.videoWidth;
  canvas.height = elements.camera.videoHeight;
  context.clearRect(0, 0, canvas.width, canvas.height);

  context.lineWidth = Math.max(2, canvas.width / 240);
  context.font = `${Math.max(14, canvas.width / 36)}px system-ui`;

  for (const prediction of predictions.filter((item) => item.class === 'person')) {
    const [x, y, width, height] = prediction.bbox;
    const mirroredX = canvas.width - x - width;
    const label = `Person ${Math.round(prediction.score * 100)}%`;
    const labelWidth = context.measureText(label).width + 12;
    const labelHeight = Math.max(22, canvas.height / 18);

    context.strokeStyle = '#46d89b';
    context.fillStyle = 'rgba(70, 216, 155, 0.13)';
    context.fillRect(mirroredX, y, width, height);
    context.strokeRect(mirroredX, y, width, height);
    context.fillStyle = '#46d89b';
    context.fillRect(mirroredX, Math.max(0, y - labelHeight), labelWidth, labelHeight);
    context.fillStyle = '#07140f';
    context.fillText(label, mirroredX + 6, Math.max(17, y - 5));
  }
}

async function detectionLoop(): Promise<void> {
  if (!monitoring) return;
  const startedAt = performance.now();

  try {
    if (!model) throw new Error('The local model is not loaded.');
    const predictions = await model.detect(elements.camera, 5, 0.5);
    const personPredictions = predictions.filter(
      (prediction) =>
        prediction.class === 'person' && prediction.score >= PERSON_SCORE_THRESHOLD,
    );
    const personDetected = personPredictions.length > 0;

    drawPredictions(personPredictions);
    elements.detectionState.textContent = personDetected
      ? `Person detected · ${Math.round(personPredictions[0]!.score * 100)}%`
      : 'No person in latest frame';
    elements.errorMessage.textContent = '';
    handleTrackerEvents(tracker.recordDetection(personDetected));
    render();
  } catch (error) {
    console.error('Detection failed:', error);
    elements.errorMessage.textContent = 'A detection frame failed; monitoring will retry.';
  } finally {
    const elapsed = performance.now() - startedAt;
    window.setTimeout(detectionLoop, Math.max(0, DETECTION_INTERVAL_MS - elapsed));
  }
}

async function loadLocalModel(): Promise<ObjectDetection> {
  elements.modelState.textContent = 'Loading local COCO-SSD model…';
  await window.tf.ready();
  const loadedModel = await window.cocoSsd.load({
    base: 'lite_mobilenet_v2',
    modelUrl: '/models/coco-ssd/model.json',
  });
  elements.modelState.textContent = `COCO-SSD ready · ${window.tf.getBackend()}`;
  return loadedModel;
}

let modelLoadError: unknown;
const modelPromise = loadLocalModel().catch((error) => {
  elements.modelState.textContent = 'Model failed to load';
  console.error('Model loading failed:', error);
  modelLoadError = error;
  return null;
});

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise<void>((resolve) =>
    video.addEventListener('loadedmetadata', () => resolve(), { once: true }),
  );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function startMonitoring(): Promise<void> {
  elements.startButton.disabled = true;
  elements.startButton.textContent = 'Starting…';
  elements.errorMessage.textContent = '';

  // Ask while handling the button click; browsers require a user gesture.
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support webcam access.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    });
    mediaStream = stream;

    const loadedModel = await modelPromise;
    if (!loadedModel) throw modelLoadError ?? new Error('The local model could not be loaded.');

    model = loadedModel;
    elements.camera.srcObject = stream;
    await waitForVideoMetadata(elements.camera);
    await elements.camera.play();

    elements.placeholder.hidden = true;
    elements.startButton.textContent = 'Monitoring active';
    monitoring = true;
    render();
    sendPresenceEvent();
    detectionLoop();
  } catch (error) {
    const cause = toError(error);
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = undefined;
    elements.startButton.disabled = false;
    elements.startButton.textContent = 'Try again';
    elements.errorMessage.textContent =
      cause.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow webcam access and try again.'
        : `Could not start monitoring: ${cause.message}`;
  }
}

async function sendPresenceEvent(): Promise<void> {
  clearTimeout(presenceHeartbeatTimer);
  presenceHeartbeatTimer = window.setTimeout(
    sendPresenceEvent,
    PRESENCE_HEARTBEAT_INTERVAL_MS,
  );

  const status = tracker.snapshot().status === 'present' ? 'present' : 'away';

  try {
    const response = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: new Date().toISOString(), status }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    elements.connectionDot.classList.add('is-connected');
    elements.connectionText.textContent = 'Events logging';
    refreshTimeline();
  } catch (error) {
    console.error('Could not log presence event:', error);
    elements.connectionDot.classList.remove('is-connected');
    elements.connectionText.textContent = 'Logging unavailable';
  }
}

elements.startButton.addEventListener('click', startMonitoring);
elements.notificationDelay.addEventListener('input', () => {
  elements.notificationDelay.setCustomValidity('');
});
elements.notificationDelay.addEventListener('change', () => {
  const minutes = Number(elements.notificationDelay.value);
  if (!Number.isSafeInteger(minutes) || minutes < 1) {
    elements.notificationDelay.setCustomValidity('Enter a whole number of at least 1 minute.');
    elements.notificationDelay.reportValidity();
    return;
  }

  notificationDelayMinutes = minutes;
  tracker.setNotificationDelayMs(minutes * 60_000);
  saveNotificationDelayMinutes(minutes);
  updateNotificationDelayCopy();
  handleTrackerEvents(tracker.tick());
  render();
});
elements.dismissNotification.addEventListener('click', () => {
  elements.notificationBanner.hidden = true;
});

// UI timing is independent of model speed; detection itself remains about once/second.
window.setInterval(() => {
  const events = tracker.tick();
  handleTrackerEvents(events);
  render();
}, 250);
window.setInterval(renderTimeline, 15_000);
window.setInterval(refreshTimeline, 60_000);
window.addEventListener('beforeunload', () => {
  clearTimeout(presenceHeartbeatTimer);
  mediaStream?.getTracks().forEach((track) => track.stop());
  model?.dispose();
});

updateNotificationDelayCopy();
render();
refreshTimeline();
