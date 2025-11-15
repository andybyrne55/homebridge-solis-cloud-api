# homebridge-solis-cloud-api

**A Homebridge plugin for Solis inverters** that exposes key energy metrics from your solar system and battery. Monitor PV generation, house load, grid interaction, and battery state directly in HomeKit.

> ⚠️ **Important:** The Solis API has rate limits. Do **not** set the poll interval too low (default 300s). Excessive requests may get your API access temporarily blocked.

---

## Features

This plugin exposes the following HomeKit characteristics via a **single service**:

| Characteristic           | Description                     | Unit |
|--------------------------|---------------------------------|------|
| PV Power                 | Current PV generation           | kW   |
| Battery Power            | Current battery charge/discharge power | kW |
| House Load               | Current household load          | kW   |
| Grid Import              | Power imported from the grid    | kW   |
| Grid Export              | Power exported to the grid      | kW   |
| Battery %                | Current battery charge level    | %    |
| PV Today Energy          | PV energy generated today       | kWh  |
| PV Month Energy          | PV energy generated this month  | kWh  |
| PV Year Energy           | PV energy generated this year   | kWh  |
| PV Total Energy          | Total PV energy generated       | kWh  |
| Grid Purchased Today     | Grid energy purchased today     | kWh  |
| Grid Sold Today          | Grid energy sold today          | kWh  |
| House Load Today         | Household energy used today     | kWh  |

> All energy characteristics are **read-only** and automatically updated by the plugin.

---

## Installation

Install via npm globally:

```bash
sudo npm install -g homebridge-solis-cloud-api

```
Example Config:
```
"accessories": [
    {
        "accessory": "SolisCloudAPI",
        "name": "Solis Cloud API",
        "apiKey": "YOUR_API_KEY",
        "apiSecret": "YOUR_API_SECRET",
        "deviceId": "YOUR_DEVICE_ID",
        "apiInterval": 300,
        "sensorInterval": 60
    }
]
```