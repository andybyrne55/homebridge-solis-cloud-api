# Changelog

All notable changes to this project will be documented in this file.

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