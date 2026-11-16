/**
 * The values the plugin can expose. Each metric is its own HomeKit accessory (a light sensor whose "lux" is the value),
 * so the Home app can show it as a tile and trigger automations when it rises above or drops below a level.
 *
 * Never change an `id`: it is part of the accessory UUID (rooms, scenes and automations are tied to it).
 */

export const METRIC_IDS = [
  'pvPower',
  'batteryPower',
  'batteryDischarge',
  'batteryPercent',
  'gridImport',
  'gridExport',
  'houseLoad',
  'dayPvEnergy',
  'monthPvEnergy',
  'yearPvEnergy',
  'totalPvEnergy',
  'dayGridPurchased',
  'dayGridSold',
  'dayHouseLoadEnergy',
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export interface MetricDefinition {
  id: MetricId;
  /** Accessory name, also the name of its Eve history file (`<host>_<name>_persist.json`). */
  name: string;
  unit: 'W' | 'kWh' | 'MWh' | '%';
  /** Keep an Eve history graph (instantaneous values only). */
  history: boolean;
}

export const METRICS: readonly MetricDefinition[] = [
  { id: 'pvPower', name: 'PV Power Watts', unit: 'W', history: true },
  // Was "Battery Power Watts" (charge and discharge mixed, discharge clamped to 0). Same UUID, new history file.
  { id: 'batteryPower', name: 'Battery Charge Watts', unit: 'W', history: true },
  { id: 'batteryDischarge', name: 'Battery Discharge Watts', unit: 'W', history: true },
  { id: 'batteryPercent', name: 'Battery Percentage', unit: '%', history: true },
  { id: 'gridImport', name: 'Grid Import Watts', unit: 'W', history: true },
  { id: 'gridExport', name: 'Grid Export Watts', unit: 'W', history: true },
  { id: 'houseLoad', name: 'House Load Watts', unit: 'W', history: true },
  { id: 'dayPvEnergy', name: 'PV Today Energy kWh', unit: 'kWh', history: false },
  { id: 'monthPvEnergy', name: 'PV Month Energy kWh', unit: 'kWh', history: false },
  { id: 'yearPvEnergy', name: 'PV Year Energy kWh', unit: 'kWh', history: false },
  // Lifetime total in MWh: in kWh it would pass HomeKit's 100,000 limit within the life of a system.
  { id: 'totalPvEnergy', name: 'PV Total Energy MWh', unit: 'MWh', history: false },
  { id: 'dayGridPurchased', name: 'Grid Purchased Today kWh', unit: 'kWh', history: false },
  { id: 'dayGridSold', name: 'Grid Sold Today kWh', unit: 'kWh', history: false },
  { id: 'dayHouseLoadEnergy', name: 'House Load Today kWh', unit: 'kWh', history: false },
];

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === 'string' && (METRIC_IDS as readonly string[]).includes(value);
}
