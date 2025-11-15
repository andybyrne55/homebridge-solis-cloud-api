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

        this.apiInterval = config.apiInterval || 300;
        this.sensorInterval = config.sensorInterval || 60;
        this.cache = {};

        // --- CUSTOM CHARACTERISTICS FOR ENERGY TOTALS ---
        this._pvPowerCharacteristic = this.createNumericCharacteristic("PV Power (kW)", "e2b6f0f1-1234-4a56-90ab-cdef12345601", 0, 10000, 0.01, "kW");
        this._batteryPowerCharacteristic = this.createNumericCharacteristic("Battery Power (kW)", "e2b6f0f2-1234-4a56-90ab-cdef12345602", -10000, 10000, 0.01, "kW");
        this._houseLoadCharacteristic = this.createNumericCharacteristic("House Load (kW)", "e2b6f0f3-1234-4a56-90ab-cdef12345603", 0, 10000, 0.01, "kW");
        this._gridImportCharacteristic = this.createNumericCharacteristic("Grid Import (kW)", "e2b6f0f4-1234-4a56-90ab-cdef12345604", 0, 10000, 0.01, "kW");
        this._gridExportCharacteristic = this.createNumericCharacteristic("Grid Export (kW)", "e2b6f0f5-1234-4a56-90ab-cdef12345605", 0, 10000, 0.01, "kW");
        this._batteryPercentCharacteristic = this.createNumericCharacteristic("Battery %", "e2b6f0f6-1234-4a56-90ab-cdef12345606", 0, 100, 1, "%");

        this._dayEnergyCharacteristic = this.createNumericCharacteristic("PV Today Energy (kWh)", "e2b6f0f6-1234-4a56-90ab-cdef12345606", 0, 10000, 0.01, "kWh");
        this._monthEnergyCharacteristic = this.createNumericCharacteristic("PV Month Energy (kWh)", "e2b6f0f7-1234-4a56-90ab-cdef12345607", 0, 100000, 0.01, "kWh");
        this._yearEnergyCharacteristic = this.createNumericCharacteristic("PV Year Energy (kWh)", "e2b6f0f8-1234-4a56-90ab-cdef12345608", 0, 100000, 0.01, "kWh");
        this._totalEnergyCharacteristic = this.createNumericCharacteristic("PV Total Energy (kWh)", "e2b6f0f9-1234-4a56-90ab-cdef12345609", 0, 1000000, 0.01, "kWh");

        this._batteryDischargeEnergyCharacteristic = this.createNumericCharacteristic("Battery Discharge Today (kWh)", "e2b6f0fa-1234-4a56-90ab-cdef1234560a", 0, 10000, 0.01, "kWh");
        this._batteryChargeEnergyCharacteristic = this.createNumericCharacteristic("Battery Charge Today (kWh)", "e2b6f0fb-1234-4a56-90ab-cdef1234560b", 0, 10000, 0.01, "kWh");

        this._gridPurchasedEnergyCharacteristic = this.createNumericCharacteristic("Grid Purchased Today (kWh)", "e2b6f0fc-1234-4a56-90ab-cdef1234560c", 0, 10000, 0.01, "kWh");
        this._gridSellEnergyCharacteristic = this.createNumericCharacteristic("Grid Sold Today (kWh)", "e2b6f0fd-1234-4a56-90ab-cdef1234560d", 0, 10000, 0.01, "kWh");

        this._houseLoadEnergyCharacteristic = this.createNumericCharacteristic("House Load Today (kWh)", "e2b6f0fe-1234-4a56-90ab-cdef1234560e", 0, 10000, 0.01, "kWh");

        // --- SINGLE ENERGY SERVICE ---
        this.energyService = new Service.AccessoryInformation("Solis Energy", "solisEnergy");
        this.energyService.addCharacteristic(this._pvPowerCharacteristic);
        this.energyService.addCharacteristic(this._batteryPowerCharacteristic);
        this.energyService.addCharacteristic(this._houseLoadCharacteristic);
        this.energyService.addCharacteristic(this._gridImportCharacteristic);
        this.energyService.addCharacteristic(this._gridExportCharacteristic);
        this.energyService.addCharacteristic(this._batteryPercentCharacteristic);
        this.energyService.addCharacteristic(this._dayEnergyCharacteristic);
        this.energyService.addCharacteristic(this._monthEnergyCharacteristic);
        this.energyService.addCharacteristic(this._yearEnergyCharacteristic);
        this.energyService.addCharacteristic(this._totalEnergyCharacteristic);
        this.energyService.addCharacteristic(this._batteryDischargeEnergyCharacteristic);
        this.energyService.addCharacteristic(this._batteryChargeEnergyCharacteristic);
        this.energyService.addCharacteristic(this._gridPurchasedEnergyCharacteristic);
        this.energyService.addCharacteristic(this._gridSellEnergyCharacteristic);
        this.energyService.addCharacteristic(this._houseLoadEnergyCharacteristic);

        this.updateData();
        setInterval(() => this.updateData(), this.apiInterval * 1000);
        setInterval(() => this.updateSensors(), this.sensorInterval * 1000);
    }

    createNumericCharacteristic(name, uuid, min, max, step, unit) {
        class CustomCharacteristic extends Characteristic {
            constructor() {
                super(name, uuid);
                this.setProps({
                    format: Characteristic.Formats.FLOAT,
                    unit,
                    minValue: min,
                    maxValue: max,
                    minStep: step,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        }
        return CustomCharacteristic;
    }

    md5Base64(str) {
        return crypto.createHash("md5").update(str, "utf8").digest("base64");
    }

    hmacSha1Base64(text, secret) {
        return crypto.createHmac("sha1", Buffer.from(secret, "utf8")).update(text, "utf8").digest("base64");
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

        this.log.debug(`[Solis API] Calling ${path} at ${date}`);

        let response;
        try {
            response = await fetch(this.baseUrl + path, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    "Authorization": `API ${this.apiKey}:${sign}`,
                    "Content-MD5": contentMD5,
                    "Date": date
                },
                body,
                timeout: 8000
            });
        } catch (err) {
            this.log.error("[Solis API] Network/timeout error:", err.message);
            throw err;
        }

        if (!response.ok) {
            this.log.error(`[Solis API] HTTP ${response.status}: ${response.statusText}`);
            throw new Error(`HTTP ${response.status}`);
        }

        return response.json();
    }

    async updateData() {
        this.log.debug("[Solis] updateData() start");
        try {
            const response = await this.solisRequest("/v1/api/stationDetailList", { deviceId: this.deviceId });
            if (!response?.success || !response.data?.records?.length) {
                this.log.error("Solis API returned no data:", response);
                return;
            }

            const r = response.data.records[0];
            const safe = n => (typeof n === "number" && !isNaN(n) ? n : 0);

            this.cache = {
                pvPower: safe(r.power),
                batteryPower: safe(r.batteryPower),
                batteryPercent: safe(r.batteryPercent),
                houseLoad: safe(r.familyLoadPower),
                gridImport: r.psum < 0 ? Math.abs(safe(r.psum)) : 0,
                gridExport: r.psum > 0 ? safe(r.psum) : 0,
                dayEnergy: safe(r.dayEnergy),
                monthEnergy: safe(r.monthEnergy),
                yearEnergy: safe(r.yearEnergy),
                totalEnergy: safe(r.allEnergy),
                batteryDischarge: safe(r.batteryTodayDischargeEnergy),
                batteryCharge: safe(r.batteryTodayChargeEnergy),
                gridPurchased: safe(r.gridPurchasedDayEnergy),
                gridSold: safe(r.gridSellDayEnergy),
                houseLoadEnergy: safe(r.homeLoadTodayEnergy)
            };

            this.log.info("[Solis] Cache updated:", this.cache);
            this.updateSensors();
        } catch (err) {
            this.log.error("Error updating Solis data:", err);
        }
    }

    updateSensors() {
        try {
            const c = this.cache;

            this.energyService.getCharacteristic(this._pvPowerCharacteristic).updateValue(c.pvPower);
            this.energyService.getCharacteristic(this._batteryPowerCharacteristic).updateValue(c.batteryPower);
            this.energyService.getCharacteristic(this._houseLoadCharacteristic).updateValue(c.houseLoad);
            this.energyService.getCharacteristic(this._gridImportCharacteristic).updateValue(c.gridImport);
            this.energyService.getCharacteristic(this._gridExportCharacteristic).updateValue(c.gridExport);
            this.energyService.getCharacteristic(this._batteryPercentCharacteristic).updateValue(c.batteryPercent);

            this.energyService.getCharacteristic(this._dayEnergyCharacteristic).updateValue(c.dayEnergy);
            this.energyService.getCharacteristic(this._monthEnergyCharacteristic).updateValue(c.monthEnergy);
            this.energyService.getCharacteristic(this._yearEnergyCharacteristic).updateValue(c.yearEnergy);
            this.energyService.getCharacteristic(this._totalEnergyCharacteristic).updateValue(c.totalEnergy);

            this.energyService.getCharacteristic(this._batteryDischargeEnergyCharacteristic).updateValue(c.batteryDischarge);
            this.energyService.getCharacteristic(this._batteryChargeEnergyCharacteristic).updateValue(c.batteryCharge);

            this.energyService.getCharacteristic(this._gridPurchasedEnergyCharacteristic).updateValue(c.gridPurchased);
            this.energyService.getCharacteristic(this._gridSellEnergyCharacteristic).updateValue(c.gridSold);

            this.energyService.getCharacteristic(this._houseLoadEnergyCharacteristic).updateValue(c.houseLoadEnergy);

        } catch (err) {
            this.log.error("Failed to update sensors:", err);
        }
    }

    getServices() {
        return [
            new Service.AccessoryInformation()
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, "Inverter")
                .setCharacteristic(Characteristic.SerialNumber, this.deviceId),
            this.energyService
        ];
    }
}
