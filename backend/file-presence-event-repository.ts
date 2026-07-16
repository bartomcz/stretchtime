import { appendFile, readFile } from 'node:fs/promises';
import { PresenceEventRepository } from './presence-event-repository.js';
import { isPresenceEvent, type PresenceEvent } from './presence-event.js';

export class FilePresenceEventRepository extends PresenceEventRepository {
  private readonly filePath: string;
  private pendingSave: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
  }

  override save(event: PresenceEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.pendingSave.then(() => appendFile(this.filePath, line, 'utf8'));

    // Keep later saves working even if this write fails.
    this.pendingSave = operation.catch(() => {});
    return operation;
  }

  override async findByTimeRange(from: string, to: string): Promise<PresenceEvent[]> {
    const fromMs = typeof from === 'string' ? Date.parse(from) : Number.NaN;
    const toMs = typeof to === 'string' ? Date.parse(to) : Number.NaN;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      throw new TypeError('Expected valid from and to timestamps with from before to');
    }

    // Wait for queued appends so a read cannot observe a partially updated log.
    await this.pendingSave;

    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const events = contents
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => {
        try {
          const event: unknown = JSON.parse(line);
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
