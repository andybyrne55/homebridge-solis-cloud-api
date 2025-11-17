// index.js
const crypto = require("crypto");
const fetch = require("node-fetch");

let Service, Characteristic;

module.exports = (homebridge) => {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerPlatform(
        "homebridge-solis-cloud-api",
        "SolisCloudAPI",
        SolisCloudPlatform,
        true
    );
};

class SolisCloudPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config || {};
        this.api = api;

        Service = api?.hap?.Service || Service;
        Characteristic = api?.hap?.Characteristic || Characteristic;

        this.apiKey = this.config.apiKey;
        this.apiSecret = this.config.apiSecret;
        this.deviceId = this.config.deviceId;
        this.baseUrl = this.config.baseUrl || "https://www.soliscloud.com:13333";
        this.apiInterval = this.config.apiInterval || 300; // seconds

        this.accessories = new Map(); // UUID -> accessory

        if (!this.apiKey || !this.apiSecret || !this.deviceId) {
            this.log.error("Missing required config: apiKey, apiSecret, deviceId");
            return;
        }

        this.api.on("didFinishLaunching", () => {
            this.log.info("[Solis] Platform launched — initializing accessories");
            this.initAccessories();
            this.startPolling();
        });
    }

    configureAccessory(accessory) {
        this.log.debug(`[Solis] configureAccessory: ${accessory.displayName} (${accessory.UUID})`);
        this.accessories.set(accessory.UUID, accessory);
    }

    //
    // --- CUSTOM CHARACTERISTIC FACTORY (string) ---
    //
    createStringCharacteristic(name, uuid) {
        const CharClass = class extends Characteristic {
            constructor() {
                super(name, uuid);
                this.setProps({
                    format: Characteristic.Formats.STRING,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                });
            }
        };
        return CharClass;
    }

    //
    // --- CREATE ACCESSORIES ---
    //
    initAccessories() {
        // List of numeric metrics as separate LightSensor accessories
        const lightSensorMetrics = [
            { name: "PV Power kW", idTag: "pvPower" },
            { name: "Battery Power kW", idTag: "batteryPower" },
            { name: "Grid Import kW", idTag: "gridImport" },
            { name: "Grid Export kW", idTag: "gridExport" },
            { name: "House Load kW", idTag: "houseLoad" },
            { name: "PV Today Energy kWh", idTag: "dayPvEnergy" },
            { name: "PV Month Energy kWh", idTag: "monthPvEnergy" },
            { name: "PV Year Energy kWh", idTag: "yearPvEnergy" },
            { name: "PV Total Energy kWh", idTag: "totalPvEnergy" },
            { name: "Grid Purchased Today kWh", idTag: "dayGridPurchased" },
            { name: "Grid Sold Today kWh", idTag: "dayGridSold" },
            { name: "House Load Today kWh", idTag: "dayHouseLoadEnergy" }
        ];

        for (const metric of lightSensorMetrics) {
            this.createOrRestoreAccessory({
                name: metric.name,
                idTag: metric.idTag,
                serviceType: Service.LightSensor
            });
        }

        // Battery %
        this.createOrRestoreAccessory({
            name: "Battery Percentage",
            idTag: "batteryPercent",
            serviceType: Service.BatteryService
        });

        // Data Timestamp
        const dataTsCharUUID = "e2b6f0ff-1234-4a56-90ab-cdef123456ff";
        const DataTsChar = this.createStringCharacteristic("Data Timestamp", dataTsCharUUID);
        this.createOrRestoreAccessory({
            name: "Solis Data Timestamp",
            idTag: "dataTimestamp",
            serviceType: Service.StatelessProgrammableSwitch,
            customCharacteristicClass: DataTsChar
        });
    }

    createOrRestoreAccessory({ name, idTag, serviceType, customCharacteristicClass = null }) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        let accessory = this.accessories.get(uuid);

        if (!accessory) {
            accessory = new this.api.platformAccessory(name, uuid);

            // AccessoryInformation
            accessory.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Name, name)
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, serviceType?.name || "Sensor")
                .setCharacteristic(Characteristic.SerialNumber, this.deviceId);

            // Primary service
            const service = accessory.addService(serviceType, name, idTag);
            service.setCharacteristic(Characteristic.Name, name);

            if (customCharacteristicClass) {
                service.addCharacteristic(customCharacteristicClass);
            }

            this.api.registerPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
            this.log.info(`[Solis] Created accessory: ${name}`);
        } else {
            accessory.displayName = name;
            const svc = accessory.getServiceById(serviceType, idTag);
            if (svc) svc.setCharacteristic(Characteristic.Name, name);
        }

        this.accessories.set(uuid, accessory);
        return accessory;
    }

    //
    // Polling
    //
    startPolling() {
        this.updateAllSensors();
        setInterval(() => this.updateAllSensors(), this.apiInterval * 1000);
    }

    async solisRequest(path, bodyObject) {
        const body = JSON.stringify(bodyObject);
        const contentMD5 = crypto.createHash("md5").update(body, "utf8").digest("base64");
        const date = new Date().toUTCString();
        const signStr = `POST\n${contentMD5}\napplication/json\n${date}\n${path}`;
        const sign = crypto.createHmac("sha1", Buffer.from(this.apiSecret, "utf8")).update(signStr, "utf8").digest("base64");

        try {
            const res = await fetch(this.baseUrl + path, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json;charset=UTF-8",
                    "Authorization": `API ${this.apiKey}:${sign}`,
                    "Content-MD5": contentMD5,
                    "Date": date
                },
                body,
                timeout: 10000
            });

            if (!res.ok) {
                this.log.error(`[Solis] HTTP ${res.status} ${res.statusText}`);
                throw new Error(`HTTP ${res.status}`);
            }

            return res.json();
        } catch (err) {
            this.log.error("[Solis] Request failed:", err.message || err);
            throw err;
        }
    }

    async updateAllSensors() {
        try {
            const response = await this.solisRequest("/v1/api/stationDetailList", { deviceId: this.deviceId });

            if (!response?.success || !response.data?.records?.length) {
                this.log.warn("[Solis] No data returned from API");
                return;
            }

            const r = response.data.records[0];
            const safe = (n, fallback = 0) => (typeof n === "number" && !isNaN(n) ? n : Number(n) || fallback);

            const cache = {
                pvPower: safe(r.power),
                batteryPower: safe(r.batteryPower),
                batteryPercent: safe(r.batteryPercent),
                gridImport: r.psum < 0 ? Math.abs(safe(r.psum)) : 0,
                gridExport: r.psum > 0 ? safe(r.psum) : 0,
                houseLoad: safe(r.familyLoadPower ?? r.loadPower ?? 0),

                dayPvEnergy: safe(r.dayEnergy),
                monthPvEnergy: safe(r.monthEnergy),
                yearPvEnergy: safe(r.yearEnergy),
                totalPvEnergy: safe(r.allEnergy),

                dayGridPurchased: safe(r.gridPurchasedDayEnergy),
                dayGridSold: safe(r.gridSellDayEnergy),
                dayHouseLoadEnergy: safe(r.homeLoadTodayEnergy),

                dataTimestamp: new Date(safe(r.dataTimestamp, Date.now())).toLocaleString()
            };

            // Update all numeric metrics
            Object.entries(cache).forEach(([idTag, value]) => {
                if (idTag === "batteryPercent") {
                    this.updateBattery(idTag, value);
                } else if (idTag === "dataTimestamp") {
                    this.updateDataTimestamp(idTag, value);
                } else {
                    this.updateLightSensor(idTag, value);
                }
            });

            this.log.debug("[Solis] Sensors updated:", cache);
        } catch (err) {
            this.log.error("[Solis] updateAllSensors failed:", err.message || err);
        }
    }

    updateLightSensor(idTag, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const service = accessory.getService(Service.LightSensor);
        if (!service) return;

        const safeValue = (typeof value === "number" && value === 0) ? 0.0001 : value;
        service.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, safeValue);
    }

    updateBattery(idTag, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const service = accessory.getService(Service.BatteryService);
        if (!service) return;

        const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
        service.updateCharacteristic(Characteristic.BatteryLevel, safeValue);
        const isLow = safeValue < 20;
        service.updateCharacteristic(Characteristic.StatusLowBattery, isLow ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    }

    updateDataTimestamp(idTag, str) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        // write to stateless switch
        const service = accessory.getService(Service.StatelessProgrammableSwitch);
        if (!service) return;

        const chars = service.characteristics || [];
        const strChar = chars.find(c => String(c.UUID).toLowerCase().startsWith("e2b6f0ff"));
        if (strChar) {
            service.updateCharacteristic(strChar.UUID, str);
        }

        // also update FirmwareRevision for visibility in Home app details
        const ai = accessory.getService(Service.AccessoryInformation);
        if (ai) {
            try { ai.setCharacteristic(Characteristic.FirmwareRevision, str); } catch (e) {}
        }
    }
}
