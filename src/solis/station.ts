/**
 * Turns a SolisCloud station record (stationDetailList / stationDetail) into the values the plugin shows.
 * All conversions use the unit field that comes with each value.
 */

import type { MetricId } from '../metrics.js';
import { tidy, toKWh, toNumber, toWatts } from './units.js';

export type StationState = 'online' | 'offline' | 'alarm' | 'unknown';

export interface StationReading {
  stationId: string;
  stationName: string;
  /** When SolisCloud last received data from the inverter (ms since epoch), if reported. */
  dataTimestamp?: number;
  state: StationState;
  /** Battery is charging (only when the station reports battery power). */
  batteryCharging?: boolean;
  /** Values per metric, in W, kWh or %. A metric is missing when SolisCloud did not report it (or in an unknown unit). */
  values: Partial<Record<MetricId, number>>;
}

export type StationRecord = Record<string, unknown>;

export function stationId(record: StationRecord): string | undefined {
  const id = record.id;
  if (typeof id === 'string' && id.trim()) {
    return id.trim();
  }
  if (typeof id === 'number' && Number.isFinite(id)) {
    return String(id);
  }
  return undefined;
}

export function stationName(record: StationRecord): string {
  return typeof record.stationName === 'string' && record.stationName.trim() ? record.stationName.trim() : 'Unnamed station';
}

function stateOf(record: StationRecord): StationState {
  switch (toNumber(record.state)) {
  case 1:
    return 'online';
  case 2:
    return 'offline';
  case 3:
    return 'alarm';
  default:
    return 'unknown';
  }
}

function power(record: StationRecord, field: string): number | undefined {
  return toWatts(record[field], record[`${field}Str`]);
}

function energy(record: StationRecord, field: string): number | undefined {
  return toKWh(record[field], record[`${field}Str`]);
}

export function parseStation(record: StationRecord): StationReading {
  const id = stationId(record);
  if (!id) {
    throw new Error('station record has no id');
  }
  const values: Partial<Record<MetricId, number>> = {};
  const set = (metric: MetricId, value: number | undefined, decimals = 3) => {
    if (value !== undefined && Number.isFinite(value)) {
      values[metric] = tidy(value, decimals);
    }
  };

  set('pvPower', power(record, 'power'));

  // Positive = charging, negative = discharging.
  const battery = power(record, 'batteryPower');
  let batteryCharging: boolean | undefined;
  if (battery !== undefined) {
    set('batteryPower', Math.max(battery, 0));
    set('batteryDischarge', Math.max(-battery, 0));
    batteryCharging = battery > 0;
  }

  const percent = toNumber(record.batteryPercent);
  if (percent !== undefined) {
    set('batteryPercent', Math.min(Math.max(percent, 0), 100), 1);
  }

  // Positive = exporting, negative = importing.
  const grid = power(record, 'psum');
  if (grid !== undefined) {
    set('gridImport', Math.max(-grid, 0));
    set('gridExport', Math.max(grid, 0));
  }

  set('houseLoad', power(record, 'familyLoadPower'));
  set('dayPvEnergy', energy(record, 'dayEnergy'));
  set('monthPvEnergy', energy(record, 'monthEnergy'));
  set('yearPvEnergy', energy(record, 'yearEnergy'));
  set('totalPvEnergy', energy(record, 'allEnergy'));
  set('dayGridPurchased', energy(record, 'gridPurchasedDayEnergy'));
  set('dayGridSold', energy(record, 'gridSellDayEnergy'));
  set('dayHouseLoadEnergy', energy(record, 'homeLoadTodayEnergy'));

  const ts = toNumber(record.dataTimestamp);
  return {
    stationId: id,
    stationName: stationName(record),
    dataTimestamp: ts !== undefined && ts > 0 ? ts : undefined,
    state: stateOf(record),
    batteryCharging,
    values,
  };
}

/** "name (id)" for every station, for log messages. */
export function listStationNames(records: StationRecord[]): string {
  return records.map((r) => `"${stationName(r)}" (${stationId(r) ?? 'no id'})`).join(', ') || 'none';
}

/**
 * Picks the station to show: the configured `stationId` (must exist), otherwise the one used before, otherwise the
 * first. Throws when nothing suitable is on the account.
 */
export function chooseStation(records: StationRecord[], configured?: string, remembered?: string): StationRecord {
  const withId = records.filter((r) => stationId(r) !== undefined);
  if (configured) {
    const match = withId.find((r) => stationId(r) === configured);
    if (!match) {
      throw new Error(`station ${configured} is not on this SolisCloud account (found: ${listStationNames(withId)})`);
    }
    return match;
  }
  if (!withId.length) {
    throw new Error('there are no stations on this SolisCloud account');
  }
  return withId.find((r) => stationId(r) === remembered) ?? withId[0];
}
