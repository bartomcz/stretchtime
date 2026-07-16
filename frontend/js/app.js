import { PresenceTracker, presenceDefaults } from './presence-tracker.js';
import { createTimelineSegments, OFFLINE_AFTER_MS } from './presence-timeline.js';

const DETECTION_INTERVAL_MS = 1_000;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000;
const PERSON_SCORE_THRESHOLD = 0.55;
const NOTIFICATION_DELAY_STORAGE_KEY = 'stretchtime.notificationDelayMinutes';
const DEFAULT_NOTIFICATION_DELAY_MINUTES = presenceDefaults.notificationDelayMs / 60_000;
let notificationDelayMinutes = loadNotificationDelayMinutes();
const tracker = new PresenceTracker({
  notificationDelayMs: notificationDelayMinutes * 60_000,
});

const elements = {
  camera: document.querySelector('#camera'),
  overlay: document.querySelector('#overlay'),
  placeholder: document.querySelector('#camera-placeholder'),
  modelState: document.querySelector('#model-state'),
  detectionState: document.querySelector('#detection-state'),
  statusCard: document.querySelector('#status-card'),
  presenceStatus: document.querySelector('#presence-status'),
  statusDetail: document.querySelector('#status-detail'),
  presenceDuration: document.querySelector('#presence-duration'),
  notificationStatus: document.querySelector('#notification-status'),
  notificationDelay: document.querySelector('#notification-delay'),
  notificationDelayUnit: document.querySelector('#notification-delay-unit'),
  notificationDetail: document.querySelector('#notification-detail'),
  notificationMessage: document.querySelector('#notification-message'),
  startButton: document.querySelector('#start-button'),
  errorMessage: document.querySelector('#error-message'),
  notificationBanner: document.querySelector('#notification-banner'),
  dismissNotification: document.querySelector('#dismiss-notification'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionText: document.querySelector('#connection-text'),
  timeline: document.querySelector('#presence-timeline'),
  timelineSegments: document.querySelector('#timeline-segments'),
  timelineNow: document.querySelector('#timeline-now'),
  timelineDate: document.querySelector('#timeline-date'),
  presentTotal: document.querySelector('#present-total'),
  awayTotal: document.querySelector('#away-total'),
  offlineTotal: document.querySelector('#offline-total'),
  timelineMessage: document.querySelector('#timeline-message'),
};

let model;
let mediaStream;
let monitoring = false;
let systemNotification;
let presenceHeartbeatTimer;
let timelineEvents = [];
let timelineDayStart;
let timelineRequestId = 0;

function loadNotificationDelayMinutes() {
  try {
    const savedMinutes = Number(localStorage.getItem(NOTIFICATION_DELAY_STORAGE_KEY));
    return Number.isSafeInteger(savedMinutes) && savedMinutes > 0
      ? savedMinutes
      : DEFAULT_NOTIFICATION_DELAY_MINUTES;
  } catch {
    return DEFAULT_NOTIFICATION_DELAY_MINUTES;
  }
}

function saveNotificationDelayMinutes(minutes) {
  try {
    localStorage.setItem(NOTIFICATION_DELAY_STORAGE_KEY, String(minutes));
  } catch {
    // The setting still applies for this page when storage is unavailable.
  }
}

function formatNotificationDelay(minutes) {
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function updateNotificationDelayCopy() {
  const delay = formatNotificationDelay(notificationDelayMinutes);
  elements.notificationDelay.value = notificationDelayMinutes;
  elements.notificationDelayUnit.textContent = notificationDelayMinutes === 1 ? 'minute' : 'minutes';
  elements.notificationDetail.textContent = `One alert after ${delay} per session. Changes apply immediately.`;
  elements.notificationMessage.textContent = `You have been present for ${delay}.`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function getDayBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function formatTimelineDuration(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (totalMinutes === 0) return milliseconds > 0 ? '<1m' : '0m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderTimeline(nowMs = Date.now()) {
  const { startMs, endMs } = getDayBounds(new Date(nowMs));
  if (timelineDayStart !== startMs) {
    refreshTimeline();
    return;
  }

  const elapsedEnd = Math.min(Math.max(nowMs, startMs), endMs);
  const dayDuration = endMs - startMs;
  const segments = createTimelineSegments(timelineEvents, startMs, elapsedEnd);
  const totals = { present: 0, away: 0, offline: 0 };
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
    const statusLabel = `${segment.status[0].toUpperCase()}${segment.status.slice(1)}`;
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

async function refreshTimeline() {
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
    const payload = await response.json();
    if (!Array.isArray(payload.events)) throw new Error('Invalid history response');
    if (requestId !== timelineRequestId) return;

    timelineEvents = payload.events;
    timelineDayStart = startMs;
    elements.timelineMessage.textContent = '';
    renderTimeline();
  } catch (error) {
    if (requestId !== timelineRequestId) return;
    console.error('Could not load presence history:', error);
    elements.timelineMessage.textContent = 'History unavailable';
  }
}

function render(now = Date.now()) {
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
      Math.ceil((presenceDefaults.absenceDelayMs - (now - tracker.lastSeenAt)) / 1_000),
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

function triggerNotification() {
  elements.notificationBanner.hidden = false;

  if ('Notification' in window && Notification.permission === 'granted') {
    // This branch is reached only once because PresenceTracker latches the session event.
    systemNotification = new Notification('Time to stretch', {
      body: `You have been continuously present for ${formatNotificationDelay(notificationDelayMinutes)}.`,
      tag: 'stretchtime-session',
      renotify: false,
    });
  }
}

function handleTrackerEvents(events) {
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

function drawPredictions(predictions) {
  const canvas = elements.overlay;
  const context = canvas.getContext('2d');
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

async function detectionLoop() {
  if (!monitoring) return;
  const startedAt = performance.now();

  try {
    const predictions = await model.detect(elements.camera, 5, 0.5);
    const personPredictions = predictions.filter(
      (prediction) =>
        prediction.class === 'person' && prediction.score >= PERSON_SCORE_THRESHOLD,
    );
    const personDetected = personPredictions.length > 0;

    drawPredictions(personPredictions);
    elements.detectionState.textContent = personDetected
      ? `Person detected · ${Math.round(personPredictions[0].score * 100)}%`
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

async function loadLocalModel() {
  elements.modelState.textContent = 'Loading local COCO-SSD model…';
  await window.tf.ready();
  const loadedModel = await window.cocoSsd.load({
    base: 'lite_mobilenet_v2',
    modelUrl: '/models/coco-ssd/model.json',
  });
  elements.modelState.textContent = `COCO-SSD ready · ${window.tf.getBackend()}`;
  return loadedModel;
}

let modelLoadError;
const modelPromise = loadLocalModel().catch((error) => {
  elements.modelState.textContent = 'Model failed to load';
  console.error('Model loading failed:', error);
  modelLoadError = error;
  return null;
});

function waitForVideoMetadata(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
}

async function startMonitoring() {
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
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = undefined;
    elements.startButton.disabled = false;
    elements.startButton.textContent = 'Try again';
    elements.errorMessage.textContent =
      error.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow webcam access and try again.'
        : `Could not start monitoring: ${error.message}`;
  }
}

async function sendPresenceEvent() {
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
