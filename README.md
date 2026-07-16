# StretchTime Presence Monitor

## Intro

I already have tried tens of different time trackers and pomodoro apps. I always failed to adapt them because I had to manually manage them.
I needed a fast and reliable way of knowing when I had my last break or for how long I sat on my desk without any pause. I wanted something that runs completely in the background and wouldn't need my attention or clicking around to start or stop sessions. This is why I decided to build StretchTime.

A local-only MVP that uses the laptop webcam and browser-based TensorFlow.js COCO-SSD detection to maintain a stable presence state. Video frames and presence data never leave the machine.

## Features

- Live webcam preview with local person bounding boxes
- COCO-SSD Lite MobileNet v2 inference in the browser, approximately once per second
- **Present** after 3 consecutive person detections
- **Away** after 15 seconds without a person detection
- Continuous presence timer with one break notification after an adjustable duration (30 minutes by default)
- Notification reset only after the 15-second absence transition
- Presence events sent to the local backend with `POST /api/events`
- A color-coded daily timeline for present, away, and offline periods
- Append-only newline-delimited JSON event log at `backend/events.log`
- No database, accounts, external APIs, CDNs, or runtime internet requests

## Requirements

- Node.js 22 or newer
- A modern browser with webcam and WebGL support (current Chrome, Edge, or Firefox)
- A laptop webcam or another connected camera

## Setup and run

```bash
npm install
npm start
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000), set **Notify me after** to the desired number of minutes, and select **Start monitoring**. The duration is saved in the browser and changes apply to the current session immediately. Allow camera access when prompted. Browser notification permission is optional; the in-app notification still appears if operating-system notifications are denied.

`npm install` installs the server, browser libraries, and TypeScript build tools. `npm start` compiles the TypeScript sources into the ignored `dist/` directory before starting the app. After installation, the app's runtime is fully local: TensorFlow.js is served from `node_modules`, and the model manifest and weight shards are included under `frontend/models/coco-ssd/`.

For automatic recompilation and server restarts while editing:

```bash
npm run dev
```

The server intentionally binds to `127.0.0.1`, not the LAN interface.

## Verification

```bash
npm test
npm run check
```

The tests cover event validation, append and range-query behavior, timeline construction, consecutive detection stabilization, the 15-second absence grace period, and exactly one notification per presence session.

## Presence events

The browser sends an event immediately when monitoring starts and whenever the stabilized presence state changes. Each event resets a 60-second heartbeat timer; if the state remains unchanged, the browser posts another event after one minute so the log also indicates that the app is still online:

```http
POST /api/events
Content-Type: application/json
```

```json
{
  "timestamp": "2026-07-14T12:00:00.000Z",
  "status": "present"
}
```

`status` must be `present` or `away`, and `timestamp` must be an ISO-8601 datetime. The server validates that these are the only two fields, then stores the event through the presence event repository. The default file-backed implementation appends one JSON line to `backend/events.log`; it never updates or deletes existing entries. Set `EVENT_LOG_PATH` to use a different log file.

The daily timeline reads a half-open time range with `GET /api/events?from=<ISO timestamp>&to=<ISO timestamp>`. It treats a status as offline when no new heartbeat has arrived for 90 seconds. A database-backed repository can replace the file implementation by implementing both `PresenceEventRepository.save` and `PresenceEventRepository.findByTimeRange`, then changing the construction in `backend/server.js`.

## Project structure

```text
backend/
  presence-event.ts                  Event validation and event types
  presence-event-repository.ts       Persistence contract
  file-presence-event-repository.ts  Serialized append-only file implementation
  server.ts                          Express static server and event endpoint
frontend/
  css/styles.css            Dashboard styling
  js/app.ts                 Camera, model, UI, notification, and event posting
  js/presence-tracker.ts    Stable presence state machine
  js/presence-timeline.ts   Daily status interval construction
  models/coco-ssd/          Local model manifest and weights
  index.html
test/
  event-log.test.ts
  presence-timeline.test.ts
  presence-tracker.test.ts
```

## Privacy and MVP limitations

- Webcam frames are processed directly in the page and are never sent to the backend.
- Presence state exists only in browser memory and resets when the page reloads. Timestamped status events persist in the append-only log.
- COCO-SSD accuracy depends on lighting, camera position, and whether enough of a person is visible.
- Background tabs may be throttled by the browser, so keep the dashboard open for the most consistent detection and one-minute heartbeat intervals.
