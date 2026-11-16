/**
 * Thin logging wrapper. Info = user-level events, debug = requests, raw values and polling,
 * shown at info level when the `debug` option is on (otherwise only with homebridge -D).
 */

export interface LogSink {
  info(message: string, ...params: unknown[]): void;
  warn(message: string, ...params: unknown[]): void;
  error(message: string, ...params: unknown[]): void;
  debug(message: string, ...params: unknown[]): void;
}

export class SolisLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly prefix: string,
    private readonly debugEnabled: boolean,
  ) {}

  info(message: string): void {
    this.sink.info(this.format(message));
  }

  warn(message: string): void {
    this.sink.warn(this.format(message));
  }

  error(message: string): void {
    this.sink.error(this.format(message));
  }

  debug(message: string): void {
    if (this.debugEnabled) {
      this.sink.info(this.format(`[debug] ${message}`));
    } else {
      this.sink.debug(this.format(message));
    }
  }

  private format(message: string): string {
    return this.prefix ? `${this.prefix}: ${message}` : message;
  }

  get isDebug(): boolean {
    return this.debugEnabled;
  }
}
