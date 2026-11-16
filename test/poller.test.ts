import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { validateConfig } from '../src/config.js';
import { Poller } from '../src/poller.js';
import { SolisApiError } from '../src/solis/client.js';
import { sensorStatus } from '../src/status.js';
import type { StationReading } from '../src/solis/station.js';
import { CaptureLog, until } from './helpers.js';

describe('poller', () => {
  it('backs off after repeated failures, up to 4x the interval', () => {
    const p = new Poller({ intervalMs: 100, poll: async () => {}, log: new CaptureLog().logger() });
    const delays = [0, 1, 2, 3, 4, 5, 9].map((f) => {
      p.failures = f;
      return p.nextDelayMs;
    });
    assert.deepEqual(delays, [100, 100, 100, 200, 400, 400, 400]);
  });

  it('warns once per outage and says when it is over', async () => {
    const log = new CaptureLog();
    let calls = 0;
    const poller = new Poller({
      intervalMs: 5,
      maxBackoff: 1,
      log: log.logger(),
      poll: async () => {
        calls++;
        if (calls <= 4) {
          throw new SolisApiError('SolisCloud answered HTTP 502', 'http', true);
        }
      },
    });
    poller.start();
    await until(() => poller.lastSuccessAt !== undefined);
    poller.stop();
    assert.equal(log.at('warn').length, 1);
    assert.match(log.at('warn')[0], /updates are failing: SolisCloud answered HTTP 502/);
    assert.match(log.at('info')[0], /working again \(after 4 failed attempts\)/);
    assert.equal(poller.failures, 0);
  });

  it('a single failed poll stays quiet', async () => {
    const log = new CaptureLog();
    let calls = 0;
    const poller = new Poller({
      intervalMs: 5, log: log.logger(), poll: async () => {
        if (++calls === 1) {
          throw new Error('blip');
        }
      },
    });
    poller.start();
    await until(() => poller.lastSuccessAt !== undefined);
    poller.stop();
    assert.deepEqual(log.at('warn'), []);
    assert.deepEqual(log.at('info'), []);
  });

  it('reports a wrong key straight away as an error', async () => {
    const log = new CaptureLog();
    const poller = new Poller({ intervalMs: 5, log: log.logger(), poll: async () => {
      throw new SolisApiError('SolisCloud refused the API key or secret (HTTP 403)', 'auth', false);
    } });
    poller.start();
    await until(() => poller.failures >= 3);
    poller.stop();
    assert.equal(log.at('error').length, 1);
    assert.match(log.at('error')[0], /Check the API Key ID and Secret/);
  });

  it('stops cleanly', async () => {
    let calls = 0;
    const poller = new Poller({ intervalMs: 5, log: new CaptureLog().logger(), poll: async () => {
      calls++;
    } });
    poller.start();
    await until(() => calls >= 2);
    poller.stop();
    const seen = calls;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, seen);
  });
});

describe('sensor status', () => {
  const reading = (over: Partial<StationReading> = {}): StationReading =>
    ({ stationId: '1', stationName: 'S', state: 'online', dataTimestamp: 1_000_000, hasBattery: true, values: {}, ...over });
  const base = { now: 1_000_000, startedAt: 0, lastSuccessAt: 1_000_000, staleMs: 30 * 60_000, faultWhenOffline: true };

  it('is fine with fresh data', () => {
    assert.deepEqual(sensorStatus({ ...base, reading: reading() }), { active: true, fault: false });
  });

  it('is fine during start-up before the first update', () => {
    assert.deepEqual(sensorStatus({ ...base, lastSuccessAt: undefined, startedAt: 999_000 }), { active: true, fault: false });
  });

  it('faults when SolisCloud has not answered for too long', () => {
    const s = sensorStatus({ ...base, now: base.lastSuccessAt + 31 * 60_000, reading: reading() });
    assert.equal(s.fault, true);
    assert.equal(s.active, false);
    assert.match(s.reason!, /no data from SolisCloud for 31 min/);
  });

  it('faults on an inverter alarm', () => {
    assert.equal(sensorStatus({ ...base, reading: reading({ state: 'alarm' }) }).fault, true);
  });

  it('reports an offline inverter or old data as inactive, and as a fault unless switched off', () => {
    assert.deepEqual(sensorStatus({ ...base, reading: reading({ state: 'offline' }) }),
      { active: false, fault: true, reason: 'SolisCloud reports the inverter offline' });
    const old = reading({ dataTimestamp: base.now - 45 * 60_000 });
    assert.match(sensorStatus({ ...base, reading: old }).reason!, /not reported to SolisCloud for 45 min/);
    assert.deepEqual({ ...sensorStatus({ ...base, faultWhenOffline: false, reading: old }), reason: undefined },
      { active: false, fault: false, reason: undefined });
  });
});

describe('config', () => {
  const ok = { platform: 'SolisCloudAPI', name: 'Solis', apiKey: 'k', apiSecret: 's' };

  it('needs only the key and secret', () => {
    const { config, errors, warnings } = validateConfig(ok);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(config!.baseUrl, 'https://www.soliscloud.com:13333');
    assert.equal(config!.intervalMs, 300_000);
    assert.equal(config!.staleMs, 30 * 60_000);
    assert.equal(config!.lowBatteryPercent, 20);
    assert.equal(config!.metrics.length, 14);
    assert.equal(config!.faultWhenOffline, true);
    assert.equal(config!.stationId, undefined);
    assert.equal(config!.deviceId, undefined);
  });

  it('accepts a v3 config unchanged', () => {
    const { config, warnings } = validateConfig({ ...ok, deviceId: '1000000000000000099', apiInterval: 300, baseUrl: 'https://www.soliscloud.com:13333' });
    assert.deepEqual(warnings, []);
    assert.equal(config!.deviceId, '1000000000000000099');
  });

  it('refuses to start without credentials', () => {
    const r = validateConfig({ name: 'Solis', apiKey: ' ' });
    assert.equal(r.config, undefined);
    assert.equal(r.errors.length, 2);
    assert.equal(validateConfig(undefined).config, undefined);
  });

  it('replaces bad optional values by defaults with a warning', () => {
    const { config, warnings } = validateConfig({ ...ok, apiInterval: 5, baseUrl: 'ftp://x', lowBatteryPercent: 150, staleMinutes: 'soon', debug: 'yes',
      metrics: ['pvPower', 'bogus', 'pvPower', 'houseLoad'] });
    assert.equal(config!.intervalMs, 300_000);
    assert.equal(config!.baseUrl, 'https://www.soliscloud.com:13333');
    assert.equal(config!.lowBatteryPercent, 20);
    assert.equal(config!.staleMs, 30 * 60_000);
    assert.equal(config!.debug, false);
    assert.deepEqual(config!.metrics, ['pvPower', 'houseLoad']);
    assert.equal(warnings.length, 6);
  });

  it('keeps the stale time above two polls', () => {
    const { config, warnings } = validateConfig({ ...ok, apiInterval: 900, staleMinutes: 10 });
    assert.equal(config!.staleMs, 30 * 60_000);
    assert.match(warnings[0], /shorter than two polls/);
  });

  it('keeps a v3 deviceId exactly (it is part of the accessory UUIDs) and caps long intervals', () => {
    const { config, warnings } = validateConfig({ ...ok, deviceId: '1298 ', apiInterval: 7200 });
    assert.equal(config!.deviceId, '1298 ');
    assert.equal(config!.intervalMs, 3_600_000);
    assert.match(warnings[0], /above 3600/);
    assert.equal(validateConfig({ ...ok, deviceId: '  ' }).config!.deviceId, undefined);
  });

  it('reads ids and numbers given as strings, and an empty metric list', () => {
    const { config, warnings } = validateConfig({ ...ok, stationId: 123, apiInterval: '120', metrics: [] });
    assert.equal(config!.stationId, '123');
    assert.equal(config!.intervalMs, 120_000);
    assert.deepEqual(config!.metrics, []);
    assert.match(warnings[0], /no metrics are selected/);
  });
});
