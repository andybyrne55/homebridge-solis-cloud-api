/**
 * Polls SolisCloud on a fixed interval, backs off when it keeps failing, and reports an outage once (not every poll).
 */

import type { SolisLogger } from './logger.js';
import { SolisApiError } from './solis/client.js';

export interface PollerOptions {
  intervalMs: number;
  /** One update; throws on failure. */
  poll: () => Promise<void>;
  log: SolisLogger;
  /** Longest wait between attempts, as a multiple of the interval. */
  maxBackoff?: number;
  now?: () => number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Poller {
  /** Consecutive failed updates. */
  failures = 0;
  lastSuccessAt?: number;
  readonly startedAt: number;

  private timer?: NodeJS.Timeout;
  private stopped = true;
  private reported = false;
  private readonly now: () => number;

  constructor(private readonly options: PollerOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Delay before the next attempt: the interval, doubled after repeated failures, capped at maxBackoff × interval. */
  get nextDelayMs(): number {
    const max = this.options.maxBackoff ?? 4;
    const factor = Math.min(2 ** Math.max(0, this.failures - 2), max);
    return this.options.intervalMs * factor;
  }

  private schedule(delay: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      await this.options.poll();
      if (this.reported) {
        this.options.log.info(`SolisCloud updates are working again (after ${this.failures} failed attempt${this.failures === 1 ? '' : 's'})`);
      }
      this.failures = 0;
      this.reported = false;
      this.lastSuccessAt = this.now();
    } catch (err) {
      this.failures++;
      this.report(err);
    }
    this.schedule(this.nextDelayMs);
  }

  private report(err: unknown): void {
    const log = this.options.log;
    const text = message(err);
    const next = Math.round(this.nextDelayMs / 1000);
    if (this.reported) {
      log.debug(`Update failed again (${this.failures} in a row): ${text}; next try in ${next} s`);
      return;
    }
    if (err instanceof SolisApiError && err.kind === 'auth') {
      log.error(`${text}. Check the API Key ID and Secret in the plugin settings (retrying every ${next} s).`);
      this.reported = true;
    } else if (err instanceof SolisApiError && err.kind === 'config') {
      log.error(`${text}. Check the plugin settings (retrying every ${next} s).`);
      this.reported = true;
    } else if (this.failures >= 2) {
      log.warn(`SolisCloud updates are failing: ${text}. The sensors keep their last values; retrying every ${next} s.`);
      this.reported = true;
    } else {
      log.debug(`Update failed: ${text}; next try in ${next} s`);
    }
  }
}
