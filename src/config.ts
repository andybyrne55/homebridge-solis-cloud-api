/**
 * Validation of the platform config. Only missing credentials stop the plugin; anything else that is invalid is
 * replaced by its default with a warning, so a typo never removes accessories (and their rooms and automations).
 */

import { DEFAULT_BASE_URL } from './solis/client.js';
import { isMetricId, METRICS, type MetricId } from './metrics.js';

export interface SolisConfig {
  name: string;
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /** Station to show when the account has several. */
  stationId?: string;
  /** Legacy (v3) id, only used to keep existing accessory UUIDs. */
  deviceId?: string;
  intervalMs: number;
  metrics: MetricId[];
  lowBatteryPercent: number;
  staleMs: number;
  faultWhenOffline: boolean;
  debug: boolean;
}

export const DEFAULTS = {
  name: 'Solis',
  apiInterval: 300,
  minApiInterval: 60,
  maxApiInterval: 3600,
  lowBatteryPercent: 20,
  staleMinutes: 30,
  minStaleMinutes: 10,
  maxStaleMinutes: 1440,
} as const;

export interface ValidationResult {
  config?: SolisConfig;
  errors: string[];
  warnings: string[];
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function validateConfig(raw: unknown): ValidationResult {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];

  const apiKey = str(c.apiKey);
  const apiSecret = str(c.apiSecret);
  if (!apiKey) {
    errors.push('"apiKey" (API Key ID) is missing');
  }
  if (!apiSecret) {
    errors.push('"apiSecret" (API Key Secret) is missing');
  }

  let baseUrl = DEFAULT_BASE_URL;
  if (c.baseUrl !== undefined && c.baseUrl !== '') {
    const candidate = str(c.baseUrl);
    let ok = false;
    if (candidate) {
      try {
        const u = new URL(candidate);
        ok = (u.protocol === 'https:' || u.protocol === 'http:') && !u.search && !u.hash;
      } catch {
        ok = false;
      }
    }
    if (ok && candidate) {
      baseUrl = candidate.replace(/\/+$/, '');
    } else {
      warnings.push(`"baseUrl" ${JSON.stringify(c.baseUrl)} is not a web address`);
    }
  }

  const range = (key: string, value: unknown, min: number, max: number, fallback: number, integer = true): number => {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const n = num(value);
    if (n === undefined || n < min || n > max || (integer && !Number.isInteger(n))) {
      warnings.push(`"${key}" ${JSON.stringify(value)} must be ${integer ? 'a whole number ' : ''}from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };

  const apiInterval = range('apiInterval', c.apiInterval, DEFAULTS.minApiInterval, DEFAULTS.maxApiInterval, DEFAULTS.apiInterval);
  const lowBatteryPercent = range('lowBatteryPercent', c.lowBatteryPercent, 0, 100, DEFAULTS.lowBatteryPercent);
  let staleMinutes = range('staleMinutes', c.staleMinutes, DEFAULTS.minStaleMinutes, DEFAULTS.maxStaleMinutes, DEFAULTS.staleMinutes);
  // Allow at least two missed polls before calling the data stale.
  const minStale = Math.ceil((2 * apiInterval) / 60);
  if (staleMinutes < minStale) {
    warnings.push(`"staleMinutes" ${staleMinutes} is shorter than two polls; using ${minStale}`);
    staleMinutes = minStale;
  }

  let metrics: MetricId[] = METRICS.map((m) => m.id);
  if (c.metrics !== undefined && c.metrics !== null) {
    if (!Array.isArray(c.metrics)) {
      warnings.push('"metrics" must be a list; showing all metrics');
    } else {
      const unknown = c.metrics.filter((m) => !isMetricId(m));
      if (unknown.length) {
        warnings.push(`unknown metric(s) ignored: ${unknown.map((m) => JSON.stringify(m)).join(', ')}`);
      }
      const wanted = new Set(c.metrics.filter(isMetricId));
      metrics = METRICS.map((m) => m.id).filter((id) => wanted.has(id));
      if (!metrics.length) {
        warnings.push('no metrics are selected, so no sensors are shown');
      }
    }
  }

  const bool = (key: string, fallback: boolean): boolean => {
    const value = c[key];
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    warnings.push(`"${key}" must be true or false`);
    return fallback;
  };

  const faultWhenOffline = bool('faultWhenOffline', true);
  const debug = bool('debug', false);

  if (errors.length || !apiKey || !apiSecret) {
    return { errors, warnings };
  }
  return {
    config: {
      name: str(c.name) ?? DEFAULTS.name,
      apiKey,
      apiSecret,
      baseUrl,
      stationId: str(c.stationId),
      deviceId: str(c.deviceId),
      intervalMs: apiInterval * 1000,
      metrics,
      lowBatteryPercent,
      staleMs: staleMinutes * 60_000,
      faultWhenOffline,
      debug,
    },
    errors,
    warnings,
  };
}
