/**
 * Dynamic platform: config, station discovery, accessory restore/creation/removal, polling and sensor status.
 */

import { hostname } from 'node:os';

import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import fakegato, { type FakeGatoHistoryConstructor } from 'fakegato-history';

import { MetricAccessory, type HistoryFactory, type MetricContext } from './accessory.js';
import { validateConfig, type SolisConfig } from './config.js';
import { SolisLogger } from './logger.js';
import { METRICS } from './metrics.js';
import { Poller } from './poller.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { SolisApiError, SolisClient } from './solis/client.js';
import { chooseStation, listStationNames, parseStation, type StationReading, type StationRecord } from './solis/station.js';
import { sensorStatus, type SensorStatus } from './status.js';

const STATUS_CHECK_MS = 60_000;

export class SolisCloudPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory<MetricContext>>();
  private readonly sensors = new Map<string, MetricAccessory>();
  private readonly log: SolisLogger;
  private config?: SolisConfig;
  private client?: SolisClient;
  private poller?: Poller;
  private statusTimer?: NodeJS.Timeout;
  private seed?: string;
  /** Station the current accessories were built for (undefined: not known yet, e.g. a v3 cache). */
  private seedStation?: string;
  private stopped = false;
  private reading?: StationReading;
  private lastStatus?: SensorStatus;
  private historyClass?: FakeGatoHistoryConstructor;
  private announcedStation?: string;

  constructor(
    private readonly logging: Logging,
    rawConfig: PlatformConfig,
    private readonly api: API,
  ) {
    const { config, errors, warnings } = validateConfig(rawConfig);
    this.log = new SolisLogger(logging, '', config?.debug ?? false);
    for (const w of warnings) {
      this.log.warn(`Config: ${w} – using the default instead`);
    }
    if (!config) {
      this.log.error(`Not starting: ${errors.join('; ')}. Enter your SolisCloud API key in the plugin settings.`);
    }
    this.config = config;

    api.on('didFinishLaunching', () => {
      try {
        this.start();
      } catch (err) {
        this.log.error(`Could not start: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<MetricContext>);
  }

  private start(): void {
    const config = this.config;
    if (!config) {
      // Not configured: keep the cached accessories (rooms, automations) but show that their values are not live.
      this.markCachedFaulted();
      return;
    }

    this.client = new SolisClient({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      baseUrl: config.baseUrl,
      debug: (m) => this.log.debug(m),
    });

    const remembered = this.rememberedSeed();
    const rememberedStation = this.rememberedStation();
    // Build straight away when the accessories are known (so they keep working while SolisCloud is down); a new or
    // changed station is confirmed by SolisCloud first, so a mistyped Station ID never creates accessories.
    const keepRemembered = !config.stationId || !rememberedStation || rememberedStation === config.stationId;
    const seed = config.deviceId ?? (keepRemembered ? remembered : undefined);
    if (seed) {
      this.buildAccessories(seed, rememberedStation);
    } else {
      this.log.info('Looking for your station on SolisCloud…');
    }

    this.poller = new Poller({ intervalMs: config.intervalMs, poll: () => this.update(), log: this.log });
    this.poller.start();
    this.statusTimer = setInterval(() => this.refreshStatus(), STATUS_CHECK_MS);
    this.statusTimer.unref();
    this.refreshStatus();
  }

  /** Seed of the cached accessories (the v3 deviceId or the station id), so they are kept if deviceId is removed. */
  private rememberedSeed(): string | undefined {
    return [...this.cached.values()].map((a) => a.context.seed).find((s): s is string => typeof s === 'string' && s !== '');
  }

  private rememberedStation(): string | undefined {
    return [...this.cached.values()].map((a) => a.context.stationId).find((s): s is string => typeof s === 'string' && s !== '');
  }

  private stop(): void {
    this.stopped = true;
    this.poller?.stop();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    // FakeGato's shared averaging timer would otherwise keep running.
    (this.api as unknown as { globalFakeGatoTimer?: { stop?: () => void } }).globalFakeGatoTimer?.stop?.();
  }

  private async update(): Promise<void> {
    const config = this.config!;
    const stations = await this.client!.listStations();
    if (this.stopped) {
      return;
    }
    const remembered = this.rememberedStation();
    let record: StationRecord;
    try {
      record = chooseStation(stations, config.stationId, this.reading?.stationId ?? remembered);
    } catch (err) {
      throw new SolisApiError(err instanceof Error ? err.message : String(err), 'config', false);
    }
    const reading = parseStation(record);

    if (this.announcedStation !== reading.stationId) {
      this.announcedStation = reading.stationId;
      const others = stations.length > 1 && !config.stationId
        ? ` – the account has ${stations.length} stations: ${listStationNames(stations)}; set "Station ID" to choose another`
        : '';
      this.log.info(`Showing station "${reading.stationName}" (${reading.stationId})${others}`);
    }

    // Keep the accessories (and their rooms, automations, history) unless a different station is now shown.
    // New installs (no deviceId) identify their accessories by the station they show.
    const sameStation = this.seed !== undefined && (this.seedStation === undefined || this.seedStation === reading.stationId);
    const seed = config.deviceId ?? (sameStation ? this.seed! : reading.stationId);
    if (seed !== this.seed) {
      this.buildAccessories(seed, reading.stationId);
    }
    this.seedStation = reading.stationId;

    this.reading = reading;
    const dataTime = reading.dataTimestamp ? new Date(reading.dataTimestamp).toISOString() : 'unknown';
    this.log.debug(`${reading.stationName}: state ${reading.state}, data from ${dataTime}, `
      + Object.entries(reading.values).map(([k, v]) => `${k}=${v}`).join(' '));

    const missing: string[] = [];
    for (const sensor of this.sensors.values()) {
      sensor.accessory.context.stationId = reading.stationId;
      const value = reading.values[sensor.metric.id];
      if (value === undefined) {
        missing.push(sensor.metric.name);
        continue;
      }
      sensor.update(value, reading.dataTimestamp ?? Date.now(), reading.batteryCharging, reading.hasBattery);
    }
    if (missing.length) {
      this.log.debug(`Not reported by SolisCloud this time: ${missing.join(', ')}`);
    }
    // The poller records the success after this returns; evaluate as if it already had.
    this.refreshStatus(Date.now());
  }

  private refreshStatus(successAt?: number): void {
    if (!this.poller || !this.config) {
      return;
    }
    const status = sensorStatus({
      now: Date.now(),
      startedAt: this.poller.startedAt,
      lastSuccessAt: successAt ?? this.poller.lastSuccessAt,
      reading: this.reading,
      staleMs: this.config.staleMs,
      faultWhenOffline: this.config.faultWhenOffline,
    });
    if (status.reason !== this.lastStatus?.reason) {
      if (status.reason) {
        this.log.warn(`Sensors marked ${status.fault ? 'faulty' : 'inactive'}: ${status.reason}`);
      } else if (this.lastStatus?.reason) {
        this.log.info('Sensors are showing live data again');
      }
    }
    this.lastStatus = status;
    for (const sensor of this.sensors.values()) {
      sensor.setStatus(status);
    }
  }

  private buildAccessories(seed: string, station?: string): void {
    const config = this.config!;
    this.seed = seed;
    this.seedStation = station;
    this.sensors.clear();
    const keep = new Set<string>();
    const created: PlatformAccessory<MetricContext>[] = [];
    const host = hostname().split('.')[0];

    for (const metric of METRICS.filter((m) => config.metrics.includes(m.id))) {
      const uuid = this.api.hap.uuid.generate(`solis-${seed}-${metric.id}`);
      keep.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory<MetricContext>(metric.name, uuid);
        created.push(accessory);
        this.cached.set(uuid, accessory);
      }
      accessory.context.seed = seed;
      const sensor = new MetricAccessory(accessory, metric, {
        hap: this.api.hap,
        log: this.log,
        seed,
        lowBatteryPercent: config.lowBatteryPercent,
        historyFilename: `${host}_${metric.name}_persist.json`,
        createHistory: this.historyFactory,
      });
      this.sensors.set(uuid, sensor);
      if (this.lastStatus) {
        sensor.setStatus(this.lastStatus);
      } else {
        sensor.setStatus({ active: true, fault: false });
      }
    }

    if (created.length) {
      this.log.info(`Adding ${created.map((a) => `"${a.displayName}"`).join(', ')}`);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created);
    }
    const existing = [...this.cached.values()].filter((a) => keep.has(a.UUID) && !created.includes(a));
    if (existing.length) {
      this.api.updatePlatformAccessories(existing);
    }
    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.log.info(`Removing ${stale.map((a) => `"${a.displayName}"`).join(', ')} (no longer used)`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.cached.delete(a.UUID);
      }
    }
  }

  private readonly historyFactory: HistoryFactory = (accessory, filename) => {
    try {
      this.historyClass = this.historyClass ?? fakegato(this.api);
      return new this.historyClass('custom', accessory, { storage: 'fs', filename, log: this.logging });
    } catch (err) {
      this.log.warn(`History for "${accessory.displayName}" is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  private markCachedFaulted(): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    for (const accessory of this.cached.values()) {
      for (const service of accessory.services.filter((s) => s.UUID === S.LightSensor.UUID)) {
        service.updateCharacteristic(C.StatusActive, false);
        service.updateCharacteristic(C.StatusFault, C.StatusFault.GENERAL_FAULT);
      }
    }
  }
}
