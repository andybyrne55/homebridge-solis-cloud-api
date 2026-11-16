/**
 * SolisCloud Platform API client (https://www.soliscloud.com:13333). Requests are signed POSTs:
 *   Content-MD5   = base64(md5(body))
 *   Authorization = "API " + keyId + ":" + base64(hmac-sha1(secret, "POST\n" + md5 + "\napplication/json\n" + date + "\n" + path))
 */

import { createHash, createHmac } from 'node:crypto';

import type { StationRecord } from './station.js';

export const DEFAULT_BASE_URL = 'https://www.soliscloud.com:13333';
const STATION_LIST_PATH = '/v1/api/stationDetailList';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export type SolisErrorKind = 'auth' | 'config' | 'http' | 'api' | 'network' | 'timeout' | 'format';

export class SolisApiError extends Error {
  constructor(
    message: string,
    readonly kind: SolisErrorKind,
    /** Worth retrying straight away (network trouble, timeouts, rate limits, server errors). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SolisApiError';
  }
}

export interface SolisClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Delay before the single retry of a failed request. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  debug?: (message: string) => void;
}

export interface SignedHeaders {
  'Content-MD5': string;
  'Content-Type': string;
  Date: string;
  Authorization: string;
}

export function signRequest(apiKey: string, apiSecret: string, path: string, body: string, date: string): SignedHeaders {
  const contentMd5 = createHash('md5').update(body, 'utf8').digest('base64');
  const toSign = `POST\n${contentMd5}\napplication/json\n${date}\n${path}`;
  const signature = createHmac('sha1', apiSecret).update(toSign, 'utf8').digest('base64');
  return {
    'Content-MD5': contentMd5,
    'Content-Type': 'application/json;charset=UTF-8',
    Date: date,
    Authorization: `API ${apiKey}:${signature}`,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : '';
    return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
  }
  return String(err);
}

export class SolisClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: SolisClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /** All stations on the account, with live values. */
  async listStations(): Promise<StationRecord[]> {
    const stations: StationRecord[] = [];
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const data = await this.request(STATION_LIST_PATH, { pageNo, pageSize: PAGE_SIZE });
      const page = (data && typeof data === 'object' ? data : {}) as { records?: unknown; total?: unknown; page?: { records?: unknown; total?: unknown } };
      const records = Array.isArray(page.records) ? page.records : Array.isArray(page.page?.records) ? page.page.records : undefined;
      if (!records) {
        throw new SolisApiError('SolisCloud answered without a station list', 'format', false);
      }
      for (const r of records) {
        if (r && typeof r === 'object') {
          stations.push(r as StationRecord);
        }
      }
      const total = Number(page.total ?? page.page?.total);
      if (records.length < PAGE_SIZE || (Number.isFinite(total) && stations.length >= total)) {
        break;
      }
    }
    return stations;
  }

  /** Signed POST with one retry for transient failures. Returns the `data` field. */
  async request(path: string, payload: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.requestOnce(path, payload);
    } catch (err) {
      if (err instanceof SolisApiError && err.retryable) {
        this.options.debug?.(`${path} failed (${err.message}), retrying in ${this.retryDelayMs} ms`);
        await sleep(this.retryDelayMs);
        return this.requestOnce(path, payload);
      }
      throw err;
    }
  }

  private async requestOnce(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify(payload);
    const headers = signRequest(this.options.apiKey, this.options.apiSecret, path, body, this.now().toUTCString());
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method: 'POST',
        headers: { ...headers },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new SolisApiError(`no answer within ${Math.round(this.timeoutMs / 1000)} s`, 'timeout', true);
      }
      throw new SolisApiError(`cannot reach SolisCloud: ${describe(err)}`, 'network', true);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new SolisApiError(`connection dropped while reading the answer: ${describe(err)}`, 'network', true);
    }

    if (res.status === 401 || res.status === 403) {
      throw new SolisApiError(`SolisCloud refused the API key or secret (HTTP ${res.status})`, 'auth', false);
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new SolisApiError(`SolisCloud answered HTTP ${res.status}`, 'http', retryable);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SolisApiError('SolisCloud answered with something that is not JSON', 'format', true);
    }
    const envelope = (json && typeof json === 'object' ? json : {}) as { success?: unknown; code?: unknown; msg?: unknown; data?: unknown };
    if (envelope.success !== true || String(envelope.code ?? '0') !== '0') {
      const msg = typeof envelope.msg === 'string' && envelope.msg ? envelope.msg : 'request failed';
      throw new SolisApiError(`SolisCloud error ${String(envelope.code ?? '?')}: ${msg}`, 'api', false);
    }
    this.options.debug?.(`${path} OK (${text.length} bytes)`);
    return envelope.data;
  }
}
