/**
 * A fake SolisCloud API server. It checks the request signature like the real one and answers from a script.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const KEY = 'test-key';
export const SECRET = 'test-secret';

export function fixture(): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(new URL('../../test/fixtures/stationDetailList.json', import.meta.url), 'utf8')) as {
    data: { records: Record<string, unknown>[] };
  };
  return raw.data.records[0];
}

export type Reply =
  | { kind: 'stations'; records: Record<string, unknown>[]; total?: number }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'api-error'; code: string; msg: string }
  | { kind: 'hang' }
  | { kind: 'garbage' };

export interface Received {
  path: string;
  body: Record<string, unknown>;
  signatureOk: boolean;
}

export class FakeSolis {
  readonly received: Received[] = [];
  /** Replies used in order; when only one is left it is repeated. */
  replies: Reply[] = [];
  private server?: Server;
  private readonly hanging: ServerResponse[] = [];

  constructor(replies: Reply[] = []) {
    this.replies = replies;
  }

  get url(): string {
    const port = (this.server!.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) {
      res.destroy();
    }
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const path = req.url ?? '';
    const md5 = createHash('md5').update(text, 'utf8').digest('base64');
    const toSign = `POST\n${md5}\napplication/json\n${req.headers.date}\n${path}`;
    const expected = `API ${KEY}:${createHmac('sha1', SECRET).update(toSign).digest('base64')}`;
    const signatureOk = req.method === 'POST' && req.headers['content-md5'] === md5 && req.headers.authorization === expected
      && String(req.headers['content-type']).startsWith('application/json');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    this.received.push({ path, body, signatureOk });

    if (!signatureOk) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"code":"403","msg":"wrong sign"}');
      return;
    }
    const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    if (!reply) {
      res.writeHead(500).end();
      return;
    }
    switch (reply.kind) {
    case 'stations': {
      const pageNo = Number(body.pageNo ?? 1);
      const pageSize = Number(body.pageSize ?? 100);
      const records = reply.records.slice((pageNo - 1) * pageSize, pageNo * pageSize);
      const json = { success: true, code: '0', msg: 'success', data: { total: reply.total ?? reply.records.length, records } };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      return;
    }
    case 'status':
      res.writeHead(reply.status).end(reply.body ?? '');
      return;
    case 'api-error':
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, code: reply.code, msg: reply.msg }));
      return;
    case 'garbage':
      res.writeHead(200).end('<html>maintenance</html>');
      return;
    case 'hang':
      this.hanging.push(res);
      return;
    }
  }
}
