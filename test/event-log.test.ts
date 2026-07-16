import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilePresenceEventRepository } from '../backend/file-presence-event-repository.js';
import { isPresenceEvent, type PresenceEvent } from '../backend/presence-event.js';
import { PresenceEventRepository } from '../backend/presence-event-repository.js';

test('accepts only timestamp and supported status fields', () => {
  assert.equal(
    isPresenceEvent({ timestamp: '2026-07-14T12:00:00.000Z', status: 'present' }),
    true,
  );
  assert.equal(
    isPresenceEvent({ timestamp: '2026-07-14T12:00:01.000Z', status: 'away' }),
    true,
  );
  assert.equal(
    isPresenceEvent({ timestamp: 'not-a-date', status: 'present' }),
    false,
  );
  assert.equal(
    isPresenceEvent({ timestamp: '2026-07-14T12:00:00.000Z', status: 'not-present' }),
    false,
  );
  assert.equal(
    isPresenceEvent({
      timestamp: '2026-07-14T12:00:00.000Z',
      status: 'present',
      personDetected: true,
    }),
    false,
  );
});

test('appends events as newline-delimited JSON in call order', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stretchtime-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'events.log');
  const repository = new FilePresenceEventRepository(filePath);
  assert.ok(repository instanceof PresenceEventRepository);
  const first: PresenceEvent = { timestamp: '2026-07-14T12:00:00.000Z', status: 'away' };
  const second: PresenceEvent = { timestamp: '2026-07-14T12:00:01.000Z', status: 'present' };

  await Promise.all([repository.save(first), repository.save(second)]);

  assert.equal(await readFile(filePath, 'utf8'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
});

test('finds events in a half-open time range in timestamp order', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stretchtime-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new FilePresenceEventRepository(path.join(directory, 'events.log'));
  const events: PresenceEvent[] = [
    { timestamp: '2026-07-14T12:02:00.000Z', status: 'away' },
    { timestamp: '2026-07-14T12:00:00.000Z', status: 'present' },
    { timestamp: '2026-07-14T12:01:00.000Z', status: 'present' },
  ];
  await Promise.all(events.map((event) => repository.save(event)));

  assert.deepEqual(
    await repository.findByTimeRange(
      '2026-07-14T12:00:00.000Z',
      '2026-07-14T12:02:00.000Z',
    ),
    [events[1], events[2]],
  );
});

test('returns no events when the log file does not exist', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stretchtime-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new FilePresenceEventRepository(path.join(directory, 'events.log'));

  assert.deepEqual(
    await repository.findByTimeRange(
      '2026-07-14T00:00:00.000Z',
      '2026-07-15T00:00:00.000Z',
    ),
    [],
  );
});
