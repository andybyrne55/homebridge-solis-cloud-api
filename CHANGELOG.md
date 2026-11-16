# Changelog

All notable changes to this project are documented in this file.

## 4.0.0 (2026-11-16)

Rewritten on the current Homebridge plugin template (TypeScript, tests, CI). Existing accessories, rooms, automations
and history are kept; see "Upgrading from version 3" in the README.

### Fixed
- Battery discharge was shown as 0 W. Battery Power Watts is now **Battery Charge Watts**, plus a new
  **Battery Discharge Watts** sensor.
- Values reported in other units were misread: PV Year and PV Total Energy (reported in MWh) were 1,000 times too small.
  All values are now converted using the unit SolisCloud sends with them.
- The configured Device ID was sent to SolisCloud as a filter it does not support; the first station was always used.
  The plugin now finds the station itself (optional Station ID for accounts with several).
- Polling now stops when Homebridge shuts down.
- The npm package no longer contains a sample API response with station details.

### Added
- Choose which sensors to show.
- Battery status on Battery Percentage: level, charging and a low-battery warning (configurable level).
- Fault status on every sensor when the data is not current, the inverter is offline or SolisCloud reports an alarm.
- Requests time out after 15 s and are retried once; repeated failures back off (up to 4× the interval) and are
  logged once per outage, with a message when updates work again.
- Settings for every option in the Homebridge UI; the API secret is a password field.

### Changed
- Requires Node.js 22, 24 or 26 and Homebridge 1.8 or 2.x.
- The Device ID is optional (kept for version 3 setups) and the setup script was removed.
- No dependencies apart from fakegato-history.

## 3.4.4 (2026-08-02)
### Fixed
- Fixed crash on Homebridge v2 caused by use of the removed HAP-NodeJS method `getServiceByUUIDAndSubType()`. Replaced with `getServiceById()` in both accessory creation/repair and sensor update paths.
### Changed
- Declared support for Homebridge v2 (`^1.6.0 || ^2.0.0`) and updated Node engine range in `package.json`.

## 3.4.3 (2025-11-19)
### Added
- FakeGato timestamp is coming from Solis data timestamp itself, which is more accurate
- Added protection for timestamps coming out of order or duplicate ones

## 3.4.2 (2025-11-18)
### Added
- First version that will be supported
