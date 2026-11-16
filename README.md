# homebridge-solis-cloud-api

[![Build, lint and test](https://github.com/andybyrne55/homebridge-solis-cloud-api/actions/workflows/build.yml/badge.svg)](https://github.com/andybyrne55/homebridge-solis-cloud-api/actions/workflows/build.yml)
[![npm](https://img.shields.io/npm/v/homebridge-solis-cloud-api)](https://www.npmjs.com/package/homebridge-solis-cloud-api)

Your **Solis** solar inverter in Apple Home, through [Homebridge](https://homebridge.io) and the SolisCloud API:
solar (PV) power, battery charge and discharge, battery level, grid import and export, house load and daily/monthly/yearly
energy totals, with history graphs in the Eve app.

Tip: put all the sensors in their own room (for example "Solar"), so they do not clutter your other rooms.

## Sensors

HomeKit has no "power" or "energy" sensor, so each value is a **light sensor** whose reading (in lux) is the value.
That is what makes it visible in the Home app and usable in automations.

| Sensor | Value | Eve history |
|---|---|---|
| PV Power Watts | Solar power now (W) | yes |
| Battery Charge Watts | Power going into the battery (W), 0 when discharging | yes |
| Battery Discharge Watts | Power coming out of the battery (W), 0 when charging | yes |
| Battery Percentage | Battery level (%), plus a battery status – see below | yes |
| Grid Import Watts | Power bought from the grid (W) | yes |
| Grid Export Watts | Power sold to the grid (W) | yes |
| House Load Watts | Power your home is using (W) | yes |
| PV Today / Month / Year / Total Energy kWh | Solar energy produced (kWh) | – |
| Grid Purchased Today kWh | Energy bought today (kWh) | – |
| Grid Sold Today kWh | Energy sold today (kWh) | – |
| House Load Today kWh | Energy used today (kWh) | – |

Untick the ones you don't need under **Sensors** in the plugin settings; they are removed from HomeKit.

HomeKit cannot show 0 on a light sensor, so zero is shown as 0.0001 lux.

### Battery status

Once SolisCloud reports a battery, the Battery Percentage sensor also gets a **battery** status: the Home app shows
the level, whether it is charging, and a **low battery** warning at or below the level you set (default 20 %).
No battery? Untick the three battery sensors.

### Faults

If the values stop being current, every sensor shows a **fault** in the Home app (and the log says why):

- SolisCloud has not answered for longer than **Report a fault after** (default 30 minutes), or
- the inverter has not sent new data to SolisCloud for that long, or SolisCloud reports it offline, or
- SolisCloud reports an alarm on the inverter.

The sensors keep their last values meanwhile. If your inverter switches off every night (systems without a battery),
untick **Report an offline inverter as a fault** to avoid an overnight fault.

## Automations and notifications

In the Home app, create an automation with **A sensor detects something** › choose a sensor › **rises above** or
**drops below** a level. Examples:

- Grid Export Watts rises above 2000 → switch on the hot-water immersion or the dishwasher plug.
- Battery Percentage drops below 30 → turn off non-essential plugs.
- PV Power Watts drops below 50 → it's getting dark: switch on the porch light.

Faults and the low-battery warning show up on the accessories in the Home app.

## Getting API access

You need a SolisCloud API key ID and secret. Request API access in SolisCloud by following
[Solis' guide](https://solis-service.solisinverters.com/en/support/solutions/articles/44002212561-request-api-access-soliscloud).
Nothing else is needed: the plugin finds your station by itself.

## Installation

Search for **Solis Cloud API** in the Plugins tab of the Homebridge UI, install it and fill in the settings. Or:

```bash
npm install -g homebridge-solis-cloud-api
```

Requires Homebridge 1.8 or 2.x and Node.js 22, 24 or 26.

## Configuration

Everything can be set in the Homebridge UI. Minimal `config.json`:

```json
{
  "platform": "SolisCloudAPI",
  "name": "Solis",
  "apiKey": "YOUR_KEY_ID",
  "apiSecret": "YOUR_KEY_SECRET"
}
```

| Option | Default | |
|---|---|---|
| `apiKey`, `apiSecret` | – | SolisCloud API key ID and secret (required). |
| `stationId` | first station | Only if your account has several stations; the log lists them with their ids. |
| `metrics` | all | Which sensors to show (ids as in the table above: `pvPower`, `batteryPower` (charge), `batteryDischarge`, `batteryPercent`, `gridImport`, `gridExport`, `houseLoad`, `dayPvEnergy`, `monthPvEnergy`, `yearPvEnergy`, `totalPvEnergy`, `dayGridPurchased`, `dayGridSold`, `dayHouseLoadEnergy`). |
| `lowBatteryPercent` | 20 | Low-battery warning level (%). |
| `apiInterval` | 300 | Seconds between updates (60–3600). SolisCloud only gets new inverter data about every 5 minutes, and limits how often the API may be called. |
| `staleMinutes` | 30 | Show a fault after this long without new data (10–1440, at least two updates). |
| `faultWhenOffline` | true | Show a fault when the inverter is offline or not reporting. |
| `baseUrl` | `https://www.soliscloud.com:13333` | Only if Solis gave you a different API address. |
| `deviceId` | – | Version 3 setups only: keep it, it ties your existing tiles, rooms and automations to the plugin. |
| `debug` | false | Log every update in detail. |

## Upgrading from version 3

Just update; keep your settings. Your existing tiles, rooms, automations and history stay. What changes:

- **Battery Power Watts is now Battery Charge Watts**, and there is a new **Battery Discharge Watts** sensor. Version 3
  showed discharging as 0 W. The Home app usually keeps the tile's old name, so rename it to "Battery Charge" yourself.
  Automations on it now act on the charge power. Charge history starts afresh (the old mixed history file,
  `…_Battery Power Watts_persist.json` in the Homebridge storage folder, can be deleted).
- **PV Year Energy** and **PV Total Energy** are now correct: version 3 ignored that SolisCloud reports large totals in
  MWh, so they were 1,000 times too small. Check automations that use them: the jump can trigger them.
- The Device ID is no longer needed for new setups (the plugin finds the station) and the setup script is gone.

## Privacy

The plugin talks only to SolisCloud, with your own API key, and stores nothing outside the Homebridge storage folder
(history files). There is no analytics or telemetry.

## Development

```bash
npm install
npm run lint && npm run build && npm test
```

The tests run against a fake SolisCloud server and real HAP-NodeJS. `npm run watch` starts a test Homebridge with
`test/hbConfig`.

## License

MIT © Andrew Byrne
