import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { FilePresenceEventRepository } from './file-presence-event-repository.js';
import { isPresenceEvent } from './presence-event.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const frontendRoot = path.join(projectRoot, 'frontend');
const compiledFrontendScriptsRoot = path.join(projectRoot, 'dist/frontend/js');
const eventLogPath = process.env.EVENT_LOG_PATH ?? path.join(projectRoot, 'backend/events.log');
const eventRepository = new FilePresenceEventRepository(eventLogPath);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1kb', strict: true }));

app.get('/api/events', async (request, response) => {
  const queryKeys = Object.keys(request.query);
  const { from, to } = request.query;
  const fromMs = typeof from === 'string' ? Date.parse(from) : Number.NaN;
  const toMs = typeof to === 'string' ? Date.parse(to) : Number.NaN;

  if (
    queryKeys.length !== 2 ||
    !queryKeys.includes('from') ||
    !queryKeys.includes('to') ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    fromMs >= toMs
  ) {
    response.status(400).json({ error: 'Expected valid from and to timestamps with from before to' });
    return;
  }

  try {
    const events = await eventRepository.findByTimeRange(from, to);
    response.set('Cache-Control', 'no-store').json({ events });
  } catch (error) {
    console.error('Could not read presence events:', error);
    response.status(500).json({ error: 'Could not read presence events' });
  }
});

app.post('/api/events', async (request, response) => {
  if (!isPresenceEvent(request.body)) {
    response.status(400).json({ error: 'Expected an ISO timestamp and status of present or away' });
    return;
  }

  try {
    await eventRepository.save(request.body);
    response.status(201).json({ stored: true });
  } catch (error) {
    console.error('Could not store presence event:', error);
    response.status(500).json({ error: 'Could not store presence event' });
  }
});

// Browser libraries are served from installed packages, never from a CDN.
app.get('/vendor/tf.min.js', (_request, response) => {
  response.sendFile(path.join(projectRoot, 'node_modules/@tensorflow/tfjs/dist/tf.min.js'));
});
app.get('/vendor/coco-ssd.min.js', (_request, response) => {
  response.sendFile(
    path.join(projectRoot, 'node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.min.js'),
  );
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});
app.use('/js', express.static(compiledFrontendScriptsRoot));
app.use(express.static(frontendRoot));

const server = app.listen(port, host, () => {
  console.log(`StretchTime is running at http://${host}:${port}`);
  console.log(`Presence events are appended to ${eventLogPath}`);
});

function shutDown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
