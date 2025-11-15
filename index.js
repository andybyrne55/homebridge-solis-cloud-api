// index.js
const crypto = require("crypto");
const fetch = require("node-fetch");

let Service, Characteristic;

module.exports = (homebridge) => {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-solis-cloud-api", "SolisCloudAPI", SolisCloudAPI);
};

class SolisCloudAPI {
    constructor(log, config) {
        this.log = log;

        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.deviceId = config.deviceId;
        this.baseUrl = config.baseUrl || "https://www.soliscloud.com:13333";

        //
        // --- CUSTOM CHARACTERISTICS ---
        //

        class PowerCharacteristic extends Characteristic {
            constructor() {
                super("PV Power (kW)", "e2b6f0f1-1234-4a56-90ab-cdef12345601");
                this.setProps({
                    format: Characteristic.Formats.FLOAT,
                    unit: "kW",
                    minValue: 0, maxValue: 10000, minStep: 0.01,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        }

        class DayEnergyCharacteristic extends Characteristic {
            constructor() {
                super("Day Energy (kWh)", "e2b6f0f2-1234-4a56-90ab-cdef12345602");
                this.setProps({
                    format: Characteristic.Formats.FLOAT,
                    unit: "kWh",
                    minValue: 0, maxValue: 100000, minStep: 0.01,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        }

        class GridImportCharacteristic extends Characteristic {
            constructor() {
                super("Grid Import (kW)", "e2b6f0f3-1234-4a56-90ab-cdef12345603");
                this.setProps({
                    format: Characteristic.Formats.FLOAT,
                    unit: "kW",
                    minValue: 0, maxValue: 10000, minStep: 0.01,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        }

        class GridExportCharacteristic extends Characteristic {
            constructor() {
                super("Grid Export (kW)", "e2b6f0f4-1234-4a56-90ab-cdef12345604");
                this.setProps({
                    format: Characteristic.Formats.FLOAT,
                    unit: "kW",
                    minValue: 0, maxValue: 10000, minStep: 0.01,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        }

        class NetGridFlowCharacteristic extends Characteristic {
            constructor() {
                super("Net Grid Flow (kW)", "e2b6f0f5-1234-4a56-90ab-cdef12345605");
                this.setProps({
                    format: Characteristic.Formats.FLOAT,
                    unit: "kW",
                    minValue: -10000, maxValue: 10000, minStep: 0.01,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        }

        // Save for later
        this._PowerCharacteristic = PowerCharacteristic;
        this._DayEnergyCharacteristic = DayEnergyCharacteristic;
        this._GridImportCharacteristic = GridImportCharacteristic;
        this._GridExportCharacteristic = GridExportCharacteristic;
        this._NetGridFlowCharacteristic = NetGridFlowCharacteristic;

        //
        // --- SERVICES ---
        //

        this.powerSensor = new Service.LightSensor("PV Power", "pvPower");
        this.powerSensor.addCharacteristic(PowerCharacteristic);

        this.dayEnergySensor = new Service.LightSensor("PV Day Energy", "pvDayEnergy");
        this.dayEnergySensor.addCharacteristic(DayEnergyCharacteristic);

        this.batterySensor = new Service.BatteryService("Battery SOC", "batterySensor");

        // NEW:
        this.gridImportSensor = new Service.LightSensor("Grid Import", "gridImport");
        this.gridImportSensor.addCharacteristic(GridImportCharacteristic);

        this.gridExportSensor = new Service.LightSensor("Grid Export", "gridExport");
        this.gridExportSensor.addCharacteristic(GridExportCharacteristic);

        this.netGridFlowSensor = new Service.LightSensor("Net Grid Flow", "netGridFlow");
        this.netGridFlowSensor.addCharacteristic(NetGridFlowCharacteristic);

        //
        // Update intervals
        //
        this.apiInterval = config.apiInterval || 300;
        this.sensorInterval = config.sensorInterval || 60;
        this.cache = {};

        // Start
        this.updateData();
        setInterval(() => this.updateData(), this.apiInterval * 1000);
        setInterval(() => this.updateSensors(), this.sensorInterval * 1000);
    }

    //
    // --- AUTH HELPERS ---
    //

    md5Base64(str) {
        return crypto.createHash("md5").update(str, "utf8").digest("base64");
    }

    hmacSha1Base64(text, secret) {
        return crypto.createHmac("sha1", Buffer.from(secret, "utf8"))
            .update(text, "utf8")
            .digest("base64");
    }

    getGMTTime() {
        return new Date().toUTCString();
    }

    async solisRequest(path, bodyObject) {
        const body = JSON.stringify(bodyObject);
        const contentMD5 = this.md5Base64(body);
        const date = this.getGMTTime();

        const signStr = `POST\n${contentMD5}\napplication/json\n${date}\n${path}`;
        const sign = this.hmacSha1Base64(signStr, this.apiSecret);

        const res = await fetch(this.baseUrl + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                "Authorization": `API ${this.apiKey}:${sign}`,
                "Content-MD5": contentMD5,
                "Date": date
            },
            body
        });

        return res.json();
    }

    //
    // --- DATA FETCH ---
    //

    async updateData() {
        try {
            const response = await this.solisRequest("/v1/api/stationDetailList", {
                deviceId: this.deviceId
            });

            if (!response.success) {
                this.log.error("Failed to fetch Solis data", response);
                return;
            }

            const r = response.data.records[0];

            this.cache = {
                currentPvKw: r.power,
                dayPvEnergyKwp: r.dayEnergy,
                batteryPercent: r.batteryPercent,
                netGridFlowKw: r.psum,
                gridImportKw: r.psum < 0 ? Math.abs(r.psum) : 0,
                gridExportKw: r.psum > 0 ? r.psum : 0,
            };

            this.updateSensors();
        } catch (err) {
            this.log.error("Error updating Solis data:", err);
        }
    }

    //
    // --- SENSOR UPDATE ---
    //

    updateSensors() {
        try {
            if (this.cache.currentPvKw !== undefined)
                this.powerSensor.getCharacteristic(this._PowerCharacteristic).updateValue(this.cache.currentPvKw);

            if (this.cache.dayPvEnergyKwp !== undefined)
                this.dayEnergySensor.getCharacteristic(this._DayEnergyCharacteristic).updateValue(this.cache.dayPvEnergyKwp);

            if (this.cache.batteryPercent !== undefined)
                this.batterySensor.setCharacteristic(Characteristic.BatteryLevel, this.cache.batteryPercent);

            // New grid values
            this.gridImportSensor
                .getCharacteristic(this._GridImportCharacteristic)
                .updateValue(this.cache.gridImportKw);

            this.gridExportSensor
                .getCharacteristic(this._GridExportCharacteristic)
                .updateValue(this.cache.gridExportKw);

            this.netGridFlowSensor
                .getCharacteristic(this._NetGridFlowCharacteristic)
                .updateValue(this.cache.netGridFlowKw);

        } catch (err) {
            this.log.error("Failed to update sensors:", err);
        }
    }

    //
    // --- HOMEKIT SERVICE LIST ---
    //

    getServices() {
        return [
            new Service.AccessoryInformation()
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, "Inverter")
                .setCharacteristic(Characteristic.SerialNumber, this.deviceId),

            this.powerSensor,
            this.dayEnergySensor,
            this.batterySensor,

            // New:
            this.gridImportSensor,
            this.gridExportSensor,
            this.netGridFlowSensor
        ];
    }
}
