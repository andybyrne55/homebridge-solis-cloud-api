import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { SolisApiError, SolisClient, signRequest } from '../src/solis/client.js';
import { chooseStation, parseStation } from '../src/solis/station.js';
import { tidy, toKWh, toWatts } from '../src/solis/units.js';
import { FakeSolis, fixture, KEY, SECRET } from './fake-solis.js';

describe('units', () => {
  it('converts power to W using the unit field', () => {
    assert.equal(toWatts(0.519, 'kW'), 519);
    assert.equal(toWatts(519, 'W'), 519);
    assert.equal(toWatts(1.2, 'MW'), 1_200_000);
    assert.equal(toWatts('0.5', undefined), 500, 'no unit means kW');
    assert.equal(toWatts(1, 'parsecs'), undefined, 'unknown unit is never guessed');
    assert.equal(toWatts(null, 'kW'), undefined);
    assert.equal(toWatts('abc', 'kW'), undefined);
  });

  it('converts energy to kWh using the unit field', () => {
    assert.equal(toKWh(5.643, 'MWh'), 5643);
    assert.equal(toKWh(6.9, 'kWh'), 6.9);
    assert.equal(toKWh(900, 'Wh'), 0.9);
    assert.equal(toKWh(1, 'GWh'), 1_000_000);
    assert.equal(toKWh(3, ''), 3);
  });

  it('tidies floating point noise', () => {
    assert.equal(tidy(0.519 * 1000), 519);
    assert.equal(tidy(5.643 * 1000), 5643);
  });
});

describe('station parsing (scrubbed live capture)', () => {
  const reading = parseStation(fixture());

  it('reads identity, state and timestamp', () => {
    assert.equal(reading.stationId, '1000000000000000001');
    assert.equal(reading.stationName, 'Test Station');
    assert.equal(reading.state, 'online');
    assert.equal(reading.dataTimestamp, 1794847395111);
  });

  it('splits a discharging battery into charge 0 / discharge W (was clamped to 0 before v4)', () => {
    assert.equal(reading.values.batteryPower, 0);
    assert.equal(reading.values.batteryDischarge, 519);
    assert.equal(reading.batteryCharging, false);
    assert.equal(reading.values.batteryPercent, 78);
    assert.equal(reading.hasBattery, true);
  });

  it('recognises a station without a battery and ignores absurd timestamps', () => {
    const r = parseStation({ ...fixture(), batteryPercent: 0, batteryPower: 0, dataTimestamp: '99999999999999999' });
    assert.equal(r.hasBattery, false);
    assert.equal(r.dataTimestamp, undefined);
  });

  it('honours MWh units (year/total were 1000x too small before v4)', () => {
    assert.equal(reading.values.yearPvEnergy, 5643);
    assert.equal(reading.values.totalPvEnergy, 6.081, 'lifetime total in MWh');
    assert.equal(reading.values.monthPvEnergy, 103.6);
    assert.equal(reading.values.dayPvEnergy, 6.9);
  });

  it('reads the other values', () => {
    assert.equal(reading.values.pvPower, 10);
    assert.equal(reading.values.houseLoad, 529);
    assert.equal(reading.values.gridImport, 0);
    assert.equal(reading.values.gridExport, 0);
    assert.equal(reading.values.dayGridPurchased, 11.5);
    assert.equal(reading.values.dayGridSold, 3.6);
    assert.equal(reading.values.dayHouseLoadEnergy, 12.1);
  });

  it('splits grid import/export and battery charge', () => {
    const r = parseStation({ ...fixture(), psum: -1.25, batteryPower: 2.1, batteryPowerStr: 'kW' });
    assert.equal(r.values.gridImport, 1250);
    assert.equal(r.values.gridExport, 0);
    assert.equal(r.values.batteryPower, 2100);
    assert.equal(r.values.batteryDischarge, 0);
    assert.equal(r.batteryCharging, true);
    const e = parseStation({ ...fixture(), psum: 800, psumStr: 'W' });
    assert.equal(e.values.gridExport, 800);
    assert.equal(e.values.gridImport, 0);
  });

  it('leaves out missing or unreadable values and maps states', () => {
    const r = parseStation({ id: 42, stationName: ' ', state: 3, power: 'n/a', yearEnergy: 2, yearEnergyStr: 'furlongs' });
    assert.equal(r.stationId, '42');
    assert.equal(r.stationName, 'Unnamed station');
    assert.equal(r.state, 'alarm');
    assert.deepEqual(r.values, {});
    assert.equal(r.batteryCharging, undefined);
    assert.equal(r.dataTimestamp, undefined);
    assert.equal(parseStation({ id: 'x', state: 2 }).state, 'offline');
    assert.throws(() => parseStation({ stationName: 'no id' }));
  });

  it('chooses the configured, remembered or first station', () => {
    const a = { id: 'a', stationName: 'A' };
    const b = { id: 'b', stationName: 'B' };
    assert.equal(chooseStation([a, b]), a);
    assert.equal(chooseStation([a, b], undefined, 'b'), b);
    assert.equal(chooseStation([a, b], 'b', 'a'), b);
    assert.equal(chooseStation([a, b], undefined, 'gone'), a);
    assert.throws(() => chooseStation([a, b], 'c'), /station c is not on this SolisCloud account \(found: "A" \(a\), "B" \(b\)\)/);
    assert.throws(() => chooseStation([]), /no stations/);
  });
});

describe('client', () => {
  const server = new FakeSolis();
  before(() => server.start());
  after(() => server.stop());

  const client = (overrides: Partial<ConstructorParameters<typeof SolisClient>[0]> = {}) =>
    new SolisClient({ apiKey: KEY, apiSecret: SECRET, baseUrl: server.url + '/', retryDelayMs: 10, timeoutMs: 300, ...overrides });

  it('signs like SolisCloud (known vector, computed independently)', () => {
    const h = signRequest(KEY, SECRET, '/v1/api/stationDetailList', '{"pageNo":1,"pageSize":100}', 'Mon, 16 Nov 2026 12:00:00 GMT');
    assert.equal(h['Content-MD5'], 'U0Xj//qmRi3zoyapfAAuXw==');
    assert.equal(h.Authorization, `API ${KEY}:Dys1zCB07roD2Z8wR8daXMRcrEs=`);
  });

  it('lists stations with a correctly signed request', async () => {
    server.received.length = 0;
    server.replies = [{ kind: 'stations', records: [fixture()] }];
    const stations = await client().listStations();
    assert.equal(stations.length, 1);
    assert.equal(server.received[0].path, '/v1/api/stationDetailList');
    assert.deepEqual(server.received[0].body, { pageNo: 1, pageSize: 100 });
    assert.ok(server.received[0].signatureOk);
  });

  it('pages through large accounts', async () => {
    server.received.length = 0;
    const records = Array.from({ length: 130 }, (_, i) => ({ id: String(i), stationName: `S${i}` }));
    server.replies = [{ kind: 'stations', records }];
    const stations = await client().listStations();
    assert.equal(stations.length, 130);
    assert.deepEqual(server.received.map((r) => r.body.pageNo), [1, 2]);
  });

  it('reports a wrong key as an auth error without retrying', async () => {
    server.received.length = 0;
    await assert.rejects(client({ apiSecret: 'wrong' }).listStations(), (e: unknown) => e instanceof SolisApiError && e.kind === 'auth' && !e.retryable);
    assert.equal(server.received.length, 1);
  });

  it('retries once after a server error', async () => {
    server.received.length = 0;
    server.replies = [{ kind: 'status', status: 502 }, { kind: 'stations', records: [fixture()] }];
    assert.equal((await client().listStations()).length, 1);
    assert.equal(server.received.length, 2);
  });

  it('gives up after the retry', async () => {
    server.received.length = 0;
    server.replies = [{ kind: 'status', status: 503 }];
    await assert.rejects(client().listStations(), /HTTP 503/);
    assert.equal(server.received.length, 2);
  });

  it('times out', async () => {
    server.replies = [{ kind: 'hang' }];
    await assert.rejects(client({ timeoutMs: 100 }).listStations(), (e: unknown) => e instanceof SolisApiError && e.kind === 'timeout');
  });

  it('reports SolisCloud errors and junk answers', async () => {
    server.replies = [{ kind: 'api-error', code: 'Z0001', msg: 'rate limited' }];
    await assert.rejects(client().listStations(), /SolisCloud error Z0001: rate limited/);
    server.replies = [{ kind: 'garbage' }];
    await assert.rejects(client().listStations(), (e: unknown) => e instanceof SolisApiError && e.kind === 'format');
  });

  it('reports an unreachable server', async () => {
    await assert.rejects(new SolisClient({ apiKey: KEY, apiSecret: SECRET, baseUrl: 'http://127.0.0.1:1', retryDelayMs: 1 }).listStations(),
      (e: unknown) => e instanceof SolisApiError && e.kind === 'network');
  });
});
