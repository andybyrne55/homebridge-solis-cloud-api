import { SolisLogger, type LogSink } from '../src/logger.js';

export class CaptureLog implements LogSink {
  readonly lines: { level: string; message: string }[] = [];
  info(message: string) {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string) {
    this.lines.push({ level: 'warn', message });
  }
  error(message: string) {
    this.lines.push({ level: 'error', message });
  }
  debug(message: string) {
    this.lines.push({ level: 'debug', message });
  }
  at(level: string): string[] {
    return this.lines.filter((l) => l.level === level).map((l) => l.message);
  }
  logger(): SolisLogger {
    return new SolisLogger(this, 'Solis', false);
  }
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting for condition');
    }
    await wait(5);
  }
}
