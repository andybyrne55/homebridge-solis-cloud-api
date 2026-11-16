# homebridge-solis-cloud-api v4 – design

Rebuild of the plugin on the current Homebridge plugin template, fixing every known bug and closing the gaps to the
"Verified by Homebridge" criteria (2026-11-01). Facts below were checked against live SolisCloud data on 16 Nov 2026
(captured on the owner's Homebridge Pi, credentials never left it).

## Bugs fixed (all confirmed)
1. **Battery discharge shown as 0 W.** Solis reports discharging as a negative `batteryPower` (live: -0.519 kW with
   `batteryDirection` 2, `batteryPowerFu` 519). LightSensor cannot go below 0.0001, so discharge was clamped away
   (2,790 of 4,016 logged readings on the owner's system were negative). Split into Battery Charge / Battery Discharge,
   like Grid Import / Export.
2. **Units ignored.** Every value comes with a unit field (`<field>Str`: W/kW/MW, Wh/kWh/MWh/GWh). The old code
   assumed kW/kWh: `yearEnergy` and `allEnergy` are reported in MWh, so "PV Year Energy kWh" and "PV Total Energy kWh"
   were 1,000× too small (live: 5.643 MWh shown as 5.643). Convert using the unit field.
3. **`deviceId` is not a stationDetailList parameter.** The configured deviceId does not match the station id; the API
   ignores it and returns all stations, and the plugin took the first. v4 discovers the station itself; an optional
   `stationId` selects one when the account has several. `deviceId` is kept only as the seed of existing accessory
   UUIDs (so existing tiles, rooms and automations survive) and is no longer required for new installs.
4. Polling timer never stopped on shutdown.
5. Stale data indistinguishable from live data (tiles froze silently).
6. Private data in the repo and npm package (sample response with station/installer ids, name, serial, location).
   v4 ships only `dist`, schema, README, CHANGELOG, LICENSE (`files` whitelist); the sample is replaced by a scrubbed,
   synthetic fixture under `test/`. 3.4.4 is deprecated on npm after v4 is published.
7. Dead code (`safeUpdate` fallback, `getServiceBySubtype` fallback); `node-fetch` replaced by Node's built-in fetch.

## Accessories (one LightSensor accessory per metric, as before)
| idTag (UUID seed) | Name | Source | Unit | History |
|---|---|---|---|---|
| pvPower | PV Power Watts | power | W | yes |
| batteryPower | Battery Charge Watts (was Battery Power Watts) | max(batteryPower, 0) | W | yes (new file) |
| batteryDischarge | Battery Discharge Watts (new) | max(-batteryPower, 0) | W | yes |
| batteryPercent | Battery Percentage | batteryPercent | % | yes |
| gridImport | Grid Import Watts | max(-psum, 0) | W | yes |
| gridExport | Grid Export Watts | max(psum, 0) | W | yes |
| houseLoad | House Load Watts | familyLoadPower | W | yes |
| dayPvEnergy … dayHouseLoadEnergy | as before | unit-converted | kWh | no |
UUID = `uuid.generate("solis-" + (deviceId ?? stationId) + "-" + idTag)` – unchanged for existing installs.
History files keep their existing names (`<hostname>_<legacy name>_persist.json`); Battery Charge starts a new file
because the old one mixes charge and discharge.

## New features
- **Pick your metrics** (`metrics`, default all): unticked metrics are removed from HomeKit.
- **Battery service** on the Battery Percentage accessory: Battery Level, Charging State, Low Battery (threshold
  `lowBatteryPercent`, default 20). The Home app shows the level and raises a low-battery warning.
- **Fault reporting:** every sensor shows StatusActive/StatusFault. Fault (and inactive) when SolisCloud has not
  answered for `staleMinutes` (default 30). Fault when SolisCloud reports an alarm (`state` 3). Inactive, and a fault
  unless `faultWhenOffline` is off, when the inverter is offline (`state` 2) or its `dataTimestamp` is older than
  `staleMinutes` (inverters without a battery switch off at night).
- **Automatic station discovery** (no setup script); `stationId` for multi-station accounts; the log lists the
  stations it found.
- **Resilience:** request timeout 15 s with one retry, back-off after repeated failures (up to 4× the interval),
  one warning per outage instead of one per poll, "back to normal" message.
- Automations: the Home app's light-level triggers ("rises above / drops below") work on every metric; documented.

## Standards (verified criteria 2026-11-01)
ESM + TypeScript (template), dynamic platform, does not start unless configured (missing key/secret: logs once,
keeps cached accessories, marks them faulted), no post-install scripts, settings GUI with every option (secret as a
password field), no analytics, files only in the Homebridge storage dir (FakeGato), no unhandled exceptions,
Node 22/24/26, keywords incl. `homebridge-plugin` and `supports-hap`, CI (lint, build, test on 22/24/26), GitHub release
per version, release workflow.

## Tests
Client signing (known vector), unit conversion, parsing of the scrubbed live fixture, battery/grid splits,
station selection, poller (back-off, stale detection, recovery), accessories with real HAP-NodeJS (no warnings,
values in range, faults, metric removal, UUID stability), config validation; HTTP fake SolisCloud server.
