import type { PresenceEvent } from './presence-event.js';

/**
 * Storage contract for presence events.
 *
 * Alternative persistence implementations (for example, a database) should
 * implement this class and can be substituted at the application's entry point.
 */
export class PresenceEventRepository {
  async save(_event: PresenceEvent): Promise<void> {
    throw new Error('PresenceEventRepository.save must be implemented');
  }

  /**
   * Returns events whose timestamps are in the half-open [from, to) range,
   * ordered from oldest to newest.
   */
  async findByTimeRange(_from: string, _to: string): Promise<PresenceEvent[]> {
    throw new Error('PresenceEventRepository.findByTimeRange must be implemented');
  }
}
