import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import * as hapNodejs from '@homebridge/hap-nodejs';
import type { HAP, PlatformAccessory } from 'homebridge';

import { MetricAccessory, type History, type MetricContext } from '../src/accessory.js';
import { METRICS, type MetricId } from '../src/metrics.js';
import { CaptureLog } from './helpers.js';

const hap = hapNodejs as unknown as HAP;
const { Service: S, Characteristic: C } = hap;

class RecordingHistory implements History {
  readonly entries: { time: number; lux: number }[] = [];
  addEntry(entry: { time: number; lux: number }) {
    this.entries.push(entry);
  }
}

/** A HAP-NodeJS accessory has the parts of PlatformAccessory the plugin uses. */
function makeAccessory(name: string, id = name): PlatformAccessory<MetricContext> {
  const a = new hapNodejs.Accessory(name, hapNodejs.uuid.generate(id)) as unknown as PlatformAccessory<MetricContext>;
  (a as { context: MetricContext }).context = {};
  return a;
}

function setup(metricId: MetricId, accessory = makeAccessory(metricId)) {
  const metric = METRICS.find((m) => m.id === metricId)!;
  const history = new RecordingHistory();
  const filenames: string[] = [];
  const sensor = new MetricAccessory(accessory, metric, {
    hap,
    log: new CaptureLog().logger(),
    seed: 'seed',
    lowBatteryPercent: 20,
    historyFilename: `host_${metric.name}_persist.json`,
    createHistory: (_a, filename) => {
      filenames.push(filename);
      return history;
    },
  });
  return { sensor, accessory, history, filenames };
}

describe('metric accessory (real HAP-NodeJS)', () => {
  const warnings: string[] = [];
  const original = { warn: console.warn, error: console.error };
  before(() => {
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    console.error = (...args: unknown[]) => warnings.push(args.join(' '));
  });
  after(() => {
    console.warn = original.warn;
    console.error = original.error;
    assert.deepEqual(warnings, [], 'HAP-NodeJS printed warnings');
  });

  it('builds a light sensor with status characteristics and accessory information', () => {
    const { sensor, accessory, filenames } = setup('pvPower');
    const light = accessory.getServiceById(S.LightSensor, 'pvPower')!;
    assert.equal(light, sensor.sensor);
    assert.equal(light.isPrimaryService, true);
    assert.equal(light.getCharacteristic(C.Name).value, 'PV Power Watts');
    const info = accessory.getService(S.AccessoryInformation)!;
    assert.equal(info.getCharacteristic(C.Manufacturer).value, 'Solis');
    assert.equal(info.getCharacteristic(C.SerialNumber).value, 'seed-pvPower');
    assert.deepEqual(filenames, ['host_PV Power Watts_persist.json']);
    assert.ok(light.testCharacteristic(C.StatusActive));
    assert.ok(light.testCharacteristic(C.StatusFault));
  });

  it('shows values within HomeKit limits', () => {
    const { sensor } = setup('pvPower');
    const level = () => sensor.sensor.getCharacteristic(C.CurrentAmbientLightLevel).value;
    sensor.update(1234.5, undefined);
    assert.equal(level(), 1234.5);
    sensor.update(0, undefined);
    assert.equal(level(), 0.0001);
    sensor.update(250_000, undefined);
    assert.equal(level(), 100000);
  });

  it('records history only for newer data', () => {
    const { sensor, history, accessory } = setup('houseLoad');
    sensor.update(500, 1_794_847_395_111);
    sensor.update(600, 1_794_847_395_111);
    sensor.update(700, 1_794_847_695_111);
    sensor.update(800, 1_794_847_095_111);
    assert.deepEqual(history.entries, [{ time: 1_794_847_395, lux: 500 }, { time: 1_794_847_695, lux: 700 }]);
    assert.equal(accessory.context.logging?.houseLoad, 1_794_847_695);
  });

  it('keeps no history for energy totals', () => {
    const { sensor, history, filenames } = setup('dayPvEnergy');
    sensor.update(6.9, Date.now());
    assert.deepEqual(filenames, []);
    assert.deepEqual(history.entries, []);
  });

  it('adds a battery service to Battery Percentage', () => {
    const { sensor, accessory } = setup('batteryPercent');
    const battery = accessory.getService(S.Battery)!;
    sensor.update(78, undefined, false);
    assert.equal(battery.getCharacteristic(C.BatteryLevel).value, 78);
    assert.equal(battery.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    assert.equal(battery.getCharacteristic(C.ChargingState).value, C.ChargingState.NOT_CHARGING);
    sensor.update(19.6, undefined, true);
    assert.equal(battery.getCharacteristic(C.BatteryLevel).value, 20);
    assert.equal(battery.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
    assert.equal(battery.getCharacteristic(C.ChargingState).value, C.ChargingState.CHARGING);
    assert.equal(sensor.sensor.isPrimaryService, true);
  });

  it('shows status and faults', () => {
    const { sensor } = setup('gridImport');
    sensor.setStatus({ active: false, fault: true, reason: 'x' });
    assert.equal(sensor.sensor.getCharacteristic(C.StatusActive).value, false);
    assert.equal(sensor.sensor.getCharacteristic(C.StatusFault).value, C.StatusFault.GENERAL_FAULT);
    sensor.setStatus({ active: true, fault: false });
    assert.equal(sensor.sensor.getCharacteristic(C.StatusActive).value, true);
    assert.equal(sensor.sensor.getCharacteristic(C.StatusFault).value, C.StatusFault.NO_FAULT);
  });

  it('reuses a v3 accessory: same service, renamed, stray services removed', () => {
    const accessory = makeAccessory('Battery Power Watts', 'v3');
    const v3 = accessory.addService(S.LightSensor, 'Battery Power Watts', 'batteryPower');
    accessory.addService(S.LightSensor, 'Old', 'somethingElse');
    accessory.addService(S.Battery, 'Battery', 'battery');
    const { sensor } = setup('batteryPower', accessory);
    assert.equal(sensor.sensor, v3);
    assert.equal(v3.getCharacteristic(C.Name).value, 'Battery Charge Watts');
    assert.equal(accessory.services.filter((s) => s.UUID === S.LightSensor.UUID).length, 1);
    assert.equal(accessory.getService(S.Battery), undefined);
  });

  it('is idempotent on restart (cached accessory)', () => {
    const { accessory } = setup('batteryPercent');
    const count = accessory.services.length;
    setup('batteryPercent', accessory);
    assert.equal(accessory.services.length, count);
  });
});
