import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as hapNodejs from '@homebridge/hap-nodejs';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { SolisCloudPlatform } from '../src/platform.js';
import { FakeSolis, fixture, KEY, SECRET } from './fake-solis.js';
import { until } from './helpers.js';

const { Service: S, Characteristic: C } = hapNodejs;

class FakePlatformAccessory extends hapNodejs.Accessory {
  context: Record<string, unknown> = {};
}

class FakeApi extends EventEmitter {
  readonly hap = hapNodejs;
  readonly platformAccessory = FakePlatformAccessory;
  readonly registered: PlatformAccessory[] = [];
  readonly unregistered: PlatformAccessory[] = [];
  readonly user: { storagePath: () => string };
  constructor(dir: string) {
    super();
    this.user = { storagePath: () => dir };
  }
  registerPlatformAccessories(_p: string, _n: string, list: PlatformAccessory[]) {
    this.registered.push(...list);
  }
  unregisterPlatformAccessories(_p: string, _n: string, list: PlatformAccessory[]) {
    this.unregistered.push(...list);
  }
  updatePlatformAccessories() {}
  versionGreaterOrEqual() {
    return true;
  }
}

function makeLog(lines: string[]): Logging {
  const log = ((m: string) => lines.push(`info ${m}`)) as unknown as Logging & Record<string, unknown>;
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) {
    log[level] = (m: string) => lines.push(`${level} ${m}`);
  }
  return log;
}

/** A cached v3 accessory: LightSensor with the metric id as subtype, UUID from solis-<deviceId>-<id>. */
function v3Accessory(deviceId: string, id: string, name: string): FakePlatformAccessory {
  const a = new FakePlatformAccessory(name, hapNodejs.uuid.generate(`solis-${deviceId}-${id}`));
  a.addService(S.LightSensor, name, id);
  a.context = { logging: { [id]: 1 } };
  return a;
}

describe('platform', () => {
  const server = new FakeSolis();
  let dir: string;
  before(async () => {
    await server.start();
    dir = mkdtempSync(join(tmpdir(), 'solis-'));
  });
  const apis: FakeApi[] = [];
  const warnings: string[] = [];
  const original = { warn: console.warn, error: console.error };
  before(() => {
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    console.error = (...args: unknown[]) => warnings.push(args.join(' '));
  });
  after(async () => {
    // fakegato-history keeps the last Homebridge API it was given, so its shared timer can end up on any of them.
    for (const api of apis) {
      (api as unknown as { globalFakeGatoTimer?: { stop(): void } }).globalFakeGatoTimer?.stop();
    }
    console.warn = original.warn;
    console.error = original.error;
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const launch = (config: Record<string, unknown>, cached: FakePlatformAccessory[] = []) => {
    const api = new FakeApi(dir);
    apis.push(api);
    const lines: string[] = [];
    const fullConfig = { platform: 'SolisCloudAPI', apiKey: KEY, apiSecret: SECRET, baseUrl: server.url, ...config } as PlatformConfig;
    const platform = new SolisCloudPlatform(makeLog(lines), fullConfig, api as unknown as API);
    for (const a of cached) {
      platform.configureAccessory(a as unknown as PlatformAccessory);
    }
    api.emit('didFinishLaunching');
    return { api, lines, stop: () => api.emit('shutdown') };
  };

  it('upgrades a v3 install in place: same accessories, battery split, nothing removed', async () => {
    server.replies = [{ kind: 'stations', records: [{ ...fixture(), dataTimestamp: String(Date.now()) }] }];
    const cached = [
      v3Accessory('DEV', 'pvPower', 'PV Power Watts'),
      v3Accessory('DEV', 'batteryPower', 'Battery Power Watts'),
      v3Accessory('DEV', 'yearPvEnergy', 'PV Year Energy kWh'),
    ];
    const { api, lines, stop } = launch({ deviceId: 'DEV', metrics: ['pvPower', 'batteryPower', 'batteryDischarge', 'yearPvEnergy'] }, cached);
    try {
      await until(() => lines.some((l) => l.includes('Showing station')));
    } finally {
      stop();
    }
    assert.deepEqual(api.registered.map((a) => a.displayName), ['Battery Discharge Watts']);
    assert.equal(api.unregistered.length, 0);
    const level = (a: FakePlatformAccessory, id: string) => a.getServiceById(S.LightSensor, id)!.getCharacteristic(C.CurrentAmbientLightLevel).value;
    assert.equal(level(cached[1], 'batteryPower'), 0.0001);
    assert.equal(level(api.registered[0] as unknown as FakePlatformAccessory, 'batteryDischarge'), 519);
    assert.equal(level(cached[2], 'yearPvEnergy'), 5643);
    assert.equal(cached[1].getServiceById(S.LightSensor, 'batteryPower')!.getCharacteristic(C.Name).value, 'Battery Charge Watts');
    assert.equal(cached[0].getServiceById(S.LightSensor, 'pvPower')!.getCharacteristic(C.StatusFault).value, C.StatusFault.NO_FAULT);
  });

  it('new install: finds the station, and after a restart keeps the accessories while SolisCloud is down', async () => {
    server.replies = [{ kind: 'stations', records: [{ ...fixture(), dataTimestamp: String(Date.now()) }] }];
    const first = launch({ metrics: ['pvPower', 'houseLoad'] });
    try {
      await until(() => first.api.registered.length === 2);
    } finally {
      first.stop();
    }
    const uuid = hapNodejs.uuid.generate('solis-1000000000000000001-pvPower');
    assert.ok(first.api.registered.some((a) => a.UUID === uuid));

    server.replies = [{ kind: 'status', status: 503 }];
    const cached = first.api.registered as unknown as FakePlatformAccessory[];
    const sent = server.received.length;
    const second = launch({ metrics: ['pvPower', 'houseLoad'] }, cached);
    try {
      await until(() => server.received.length >= sent + 2, 6000);
    } finally {
      second.stop();
    }
    assert.equal(second.api.registered.length, 0);
    assert.equal(second.api.unregistered.length, 0);
  });

  it('keeps the v3 accessories when deviceId is removed from the config later', async () => {
    server.replies = [{ kind: 'stations', records: [{ ...fixture(), dataTimestamp: String(Date.now()) }] }];
    const cached = [v3Accessory('DEV', 'pvPower', 'PV Power Watts')];
    const first = launch({ deviceId: 'DEV', metrics: ['pvPower'] }, cached);
    try {
      await until(() => first.lines.some((l) => l.includes('Showing station')));
    } finally {
      first.stop();
    }
    const second = launch({ metrics: ['pvPower'] }, cached);
    try {
      await until(() => second.lines.some((l) => l.includes('Showing station')));
    } finally {
      second.stop();
    }
    assert.equal(second.api.registered.length, 0);
    assert.equal(second.api.unregistered.length, 0);
    assert.equal(cached[0].getServiceById(S.LightSensor, 'pvPower')!.getCharacteristic(C.CurrentAmbientLightLevel).value, 10);
  });

  it('a station without a battery gets no battery status', async () => {
    server.replies = [{ kind: 'stations', records: [{ ...fixture(), batteryPercent: 0, batteryPower: 0, dataTimestamp: String(Date.now()) }] }];
    const { api, lines, stop } = launch({ deviceId: 'NOBAT', metrics: ['batteryPercent'] });
    try {
      await until(() => lines.some((l) => l.includes('Showing station')));
    } finally {
      stop();
    }
    assert.equal((api.registered[0] as unknown as FakePlatformAccessory).getService(S.Battery), undefined);
  });

  it('removes sensors that are unticked', async () => {
    server.replies = [{ kind: 'stations', records: [{ ...fixture(), dataTimestamp: String(Date.now()) }] }];
    const cached = [v3Accessory('DEV', 'pvPower', 'PV Power Watts'), v3Accessory('DEV', 'houseLoad', 'House Load Watts')];
    const { api, stop } = launch({ deviceId: 'DEV', metrics: ['pvPower'] }, cached);
    stop();
    assert.deepEqual(api.unregistered.map((a) => a.displayName), ['House Load Watts']);
  });

  it('does not start without credentials and marks cached sensors faulty', () => {
    const cached = [v3Accessory('DEV', 'pvPower', 'PV Power Watts')];
    const before = server.received.length;
    const { api, lines, stop } = launch({ apiKey: '', deviceId: 'DEV' }, cached);
    stop();
    assert.equal(server.received.length, before);
    assert.equal(api.unregistered.length, 0);
    assert.ok(lines.some((l) => l.startsWith('error Not starting')));
    assert.equal(cached[0].getServiceById(S.LightSensor, 'pvPower')!.getCharacteristic(C.StatusFault).value, C.StatusFault.GENERAL_FAULT);
  });

  it('reports a configured station that does not exist', async () => {
    server.replies = [{ kind: 'stations', records: [fixture()] }];
    const { api, lines, stop } = launch({ stationId: '999' });
    try {
      await until(() => lines.some((l) => l.startsWith('error station 999 is not on this SolisCloud account')));
    } finally {
      stop();
    }
    assert.equal(api.registered.length, 0);
  });

  it('printed no HAP or fakegato warnings', () => {
    assert.deepEqual(warnings.filter((w) => !w.includes('Fakegato')), []);
  });
});
