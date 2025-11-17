# homebridge-solis-cloud-api

**A Homebridge plugin for Solis Cloud API** that exposes key energy metrics from your solar inverter to Apple Home. 
Monitor PV generation, house load, grid interaction, and battery state directly in HomeKit. It is recommended to create
a new room for your "Solar Dashboard", so all the sensors are together in one place and do not clutter up your existing
rooms

> ⚠️ **Important:** The Solis API has rate limits. Do **not** set the apiInterval too low (default 300s). Excessive requests may get your API access temporarily blocked.

---

## Features

This plugin exposes the following HomeKit sensors for automation compatibility and Eve app visibility:

| Sensor / Characteristic | Description                               | Unit |
|------------------------|-------------------------------------------|------|
| PV Power               | Current PV generation                     | kW   |
| Battery Power          | Current battery charge/discharge power    | kW   |
| Battery %              | Current battery charge level              | %    |
| House Load             | Current household load                    | kW   |
| Grid Import            | Power imported from the grid              | kW   |
| Grid Export            | Power exported to the grid                | kW   |
| PV Today Energy        | PV energy generated today                 | kWh  |
| PV Month Energy        | PV energy generated this month            | kWh  |
| PV Year Energy         | PV energy generated this year             | kWh  |
| PV Total Energy        | Total PV energy generated                 | kWh  |
| Grid Purchased Today   | Grid energy purchased today               | kWh  |
| Grid Sold Today        | Grid energy sold today                    | kWh  |
| House Load Today       | Household energy used today               | kWh  |

> All numeric sensors are **read-only** and automatically updated by the plugin.

---

## ⚠️ Note on HomeKit Compatibility

- All metrics are exposed via **LightSensor** for HomeKit automation support.
  - zero values are set to be 0.0001 as homekit must have a value

---

## Installation

Install via npm globally:

```bash
cd /var/lib/homebridge
sudo npm install --unsafe-perm homebridge-solis-cloud-api
sudo systemctl restart homebridge
```

Example Config:

```json
"platforms": [
    {
        "platform": "SolisCloudAPI",
        "name": "Solis Cloud API",
        "apiKey": "YOUR_API_KEY",
        "apiSecret": "YOUR_API_SECRET",
        "deviceId": "YOUR_DEVICE_ID",
        "baseUrl": "optional url, defaults to https://www.soliscloud.com:13333",
        "apiInterval": 300,
        "room": "an optional room name"
    }
]

```

### Key, Secret and Device ID
- The **apiKey** and **apiSecret** values can be obtained by following [this guide from Solis](https://solis-service.solisinverters.com/en/support/solutions/articles/44002212561-request-api-access-soliscloud).
- Once you are granted access to the Solis Cloud API, obtain your **deviceId** by running the [solis_cloud_api-get_device_id.sh](https://github.com/andybyrne55/homebridge-solis-cloud-api/blob/main/solis_cloud_api-get_device_id.sh) script with your API credentials. The script will output the device ID as the last echo.
