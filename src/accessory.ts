/**
 * One metric = one accessory with a light sensor service (value as "lux"), optional Eve history, and for Battery
 * Percentage also a Battery service (level, charging, low battery).
 */

import type { HAP, PlatformAccessory, Service } from 'homebridge';

import type { SolisLogger } from './logger.js';
import type { MetricDefinition } from './metrics.js';
import { PLUGIN_VERSION } from './settings.js';
import { tidy } from './solis/units.js';
import type { SensorStatus } from './status.js';

/** HomeKit's range for CurrentAmbientLightLevel. */
export const MIN_LUX = 0.0001;
export const MAX_LUX = 100000;

export interface MetricContext {
  /** Seed used for the UUID (deviceId or station id). */
  seed?: string;
  stationId?: string;
  /** Last history entry time per metric (s). The name predates v4. */
  logging?: Record<string, number>;
}

export interface History {
  addEntry(entry: { time: number; lux: number }): void;
}

export type HistoryFactory = (accessory: PlatformAccessory, filename: string) => History | undefined;

export interface MetricAccessoryOptions {
  hap: HAP;
  log: SolisLogger;
  seed: string;
  lowBatteryPercent: number;
  historyFilename: string;
  createHistory?: HistoryFactory;
}

export function toLux(value: number): number {
  return Math.min(Math.max(value, MIN_LUX), MAX_LUX);
}

export class MetricAccessory {
  readonly sensor: Service;
  readonly battery?: Service;
  private readonly history?: History;

  constructor(
    readonly accessory: PlatformAccessory<MetricContext>,
    readonly metric: MetricDefinition,
    private readonly options: MetricAccessoryOptions,
  ) {
    const { Service: S, Characteristic: C } = options.hap;

    accessory.displayName = metric.name;
    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Name, metric.name)
      .setCharacteristic(C.Manufacturer, 'Solis')
      .setCharacteristic(C.Model, 'SolisCloud sensor')
      .setCharacteristic(C.SerialNumber, `${options.seed}-${metric.id}`)
      .setCharacteristic(C.FirmwareRevision, PLUGIN_VERSION);

    // Remove anything that does not belong to this metric (older versions, metric changes).
    for (const service of [...accessory.services]) {
      const strayLight = service.UUID === S.LightSensor.UUID && service.subtype !== metric.id;
      const strayBattery = service.UUID === S.Battery.UUID && metric.id !== 'batteryPercent';
      if (strayLight || strayBattery) {
        accessory.removeService(service);
      }
    }

    this.sensor = accessory.getServiceById(S.LightSensor, metric.id) ?? accessory.addService(S.LightSensor, metric.name, metric.id);
    this.sensor.setPrimaryService(true);
    this.sensor.setCharacteristic(C.Name, metric.name);
    this.sensor.getCharacteristic(C.StatusActive);
    this.sensor.getCharacteristic(C.StatusFault);

    if (metric.id === 'batteryPercent') {
      this.battery = accessory.getService(S.Battery) ?? accessory.addService(S.Battery, 'Battery', 'battery');
      this.battery.setCharacteristic(C.Name, 'Battery');
      this.battery.getCharacteristic(C.ChargingState).updateValue(C.ChargingState.NOT_CHARGING);
    }

    if (metric.history) {
      this.history = options.createHistory?.(accessory, options.historyFilename);
    }
  }

  /**
   * Shows a new value. `time` is when SolisCloud received it (ms); history only gets values newer than the last entry.
   */
  update(value: number, time: number | undefined, batteryCharging?: boolean): void {
    const C = this.options.hap.Characteristic;
    this.sensor.updateCharacteristic(C.CurrentAmbientLightLevel, toLux(value));

    if (this.battery) {
      const level = Math.round(Math.min(Math.max(value, 0), 100));
      this.battery.updateCharacteristic(C.BatteryLevel, level);
      this.battery.updateCharacteristic(
        C.StatusLowBattery,
        level <= this.options.lowBatteryPercent ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
      if (batteryCharging !== undefined) {
        this.battery.updateCharacteristic(C.ChargingState, batteryCharging ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
      }
    }

    if (this.history && time !== undefined) {
      const entryTime = Math.round(time / 1000);
      const ctx = this.accessory.context;
      ctx.logging = ctx.logging ?? {};
      if (entryTime > (ctx.logging[this.metric.id] ?? 0)) {
        this.history.addEntry({ time: entryTime, lux: tidy(value, 3) });
        ctx.logging[this.metric.id] = entryTime;
      }
    }
  }

  setStatus(status: SensorStatus): void {
    const C = this.options.hap.Characteristic;
    this.sensor.updateCharacteristic(C.StatusActive, status.active);
    this.sensor.updateCharacteristic(C.StatusFault, status.fault ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
  }
}
