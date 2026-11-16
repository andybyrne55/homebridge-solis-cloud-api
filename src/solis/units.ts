/**
 * SolisCloud reports every value together with its unit in a `<field>Str` field, and switches unit as values grow
 * (for example `yearEnergy` 5.643 with `yearEnergyStr` "MWh"). These helpers turn a value + unit into W or kWh.
 */

const POWER_FACTORS: Record<string, number> = { w: 1, kw: 1e3, mw: 1e6, gw: 1e9 };
const ENERGY_FACTORS: Record<string, number> = { wh: 1e-3, kwh: 1, mwh: 1e3, gwh: 1e6, twh: 1e9 };

/** A finite number from a SolisCloud value (numbers or numeric strings), otherwise undefined. */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function convert(value: unknown, unit: unknown, factors: Record<string, number>, fallback: string): number | undefined {
  const n = toNumber(value);
  if (n === undefined) {
    return undefined;
  }
  const key = (typeof unit === 'string' && unit.trim() ? unit : fallback).trim().toLowerCase();
  const factor = factors[key];
  return factor === undefined ? undefined : n * factor;
}

/** Power in W. Without a unit field SolisCloud means kW. Unknown units give undefined (never a wrong number). */
export function toWatts(value: unknown, unit: unknown): number | undefined {
  return convert(value, unit, POWER_FACTORS, 'kW');
}

/** Energy in kWh. Without a unit field SolisCloud means kWh. Unknown units give undefined. */
export function toKWh(value: unknown, unit: unknown): number | undefined {
  return convert(value, unit, ENERGY_FACTORS, 'kWh');
}

/** Rounds away floating point noise (0.519 * 1000 = 519.0000000000001). */
export function tidy(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
