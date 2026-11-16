/**
 * What the sensors should report about the data they show (HomeKit StatusActive / StatusFault).
 */

import type { StationReading } from './solis/station.js';

export interface StatusInput {
  now: number;
  startedAt: number;
  lastSuccessAt?: number;
  reading?: StationReading;
  staleMs: number;
  faultWhenOffline: boolean;
}

export interface SensorStatus {
  /** The value is current. */
  active: boolean;
  /** Something needs attention (shown as a warning in the Home app). */
  fault: boolean;
  /** Why, for the log; undefined when all is well. */
  reason?: string;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export function sensorStatus(input: StatusInput): SensorStatus {
  const { now, staleMs } = input;
  const since = input.lastSuccessAt ?? input.startedAt;
  if (now - since > staleMs) {
    return { active: false, fault: true, reason: `no data from SolisCloud for ${minutes(now - since)}` };
  }
  const reading = input.reading;
  if (!reading) {
    return { active: true, fault: false };
  }
  if (reading.state === 'alarm') {
    return { active: true, fault: true, reason: 'SolisCloud reports an alarm on the inverter' };
  }
  if (reading.state === 'offline') {
    return { active: false, fault: input.faultWhenOffline, reason: 'SolisCloud reports the inverter offline' };
  }
  if (reading.dataTimestamp !== undefined && now - reading.dataTimestamp > staleMs) {
    return {
      active: false,
      fault: input.faultWhenOffline,
      reason: `the inverter has not reported to SolisCloud for ${minutes(now - reading.dataTimestamp)}`,
    };
  }
  return { active: true, fault: false };
}
