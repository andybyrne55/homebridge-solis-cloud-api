declare module 'fakegato-history' {
  import type { API } from 'homebridge';

  export interface FakeGatoOptions {
    storage?: 'fs';
    path?: string;
    filename?: string;
    minutes?: number;
    disableTimer?: boolean;
    log?: unknown;
  }

  export interface FakeGatoHistory {
    addEntry(entry: { time: number } & Record<string, number>): void;
  }

  export type FakeGatoHistoryConstructor = new (type: string, accessory: unknown, options?: FakeGatoOptions) => FakeGatoHistory;

  const factory: (api: API) => FakeGatoHistoryConstructor;
  export default factory;
}
