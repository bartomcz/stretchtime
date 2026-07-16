import { appendFile, readFile } from 'node:fs/promises';
import { PresenceEventRepository } from './presence-event-repository.js';
import { isPresenceEvent } from './presence-event.js';

export class FilePresenceEventRepository extends PresenceEventRepository {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.pendingSave = Promise.resolve();
  }

  save(event) {
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.pendingSave.then(() => appendFile(this.filePath, line, 'utf8'));

    // Keep later saves working even if this write fails.
    this.pendingSave = operation.catch(() => {});
    return operation;
  }

  async findByTimeRange(from, to) {
    const fromMs = typeof from === 'string' ? Date.parse(from) : Number.NaN;
    const toMs = typeof to === 'string' ? Date.parse(to) : Number.NaN;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new TypeError('Expected valid from and to timestamps with from before to');
    }

    // Wait for queued appends so a read cannot observe a partially updated log.
    await this.pendingSave;

    let contents;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const events = contents
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => {
        try {
          const event = JSON.parse(line);
          if (!isPresenceEvent(event)) throw new Error('invalid presence event');
          return event;
        } catch (error) {
          throw new Error(`Invalid presence event on line ${index + 1}`, { cause: error });
        }
      })
      .filter((event) => {
        const timestamp = Date.parse(event.timestamp);
        return timestamp >= fromMs && timestamp < toMs;
      });

    return events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  }
}
