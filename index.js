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

        // Configuration
        this.apiKey = this.config.apiKey;
        this.apiSecret = this.config.apiSecret;
        this.deviceId = this.config.deviceId;
        this.baseUrl = this.config.baseUrl || "https://www.soliscloud.com:13333";
        this.apiInterval = this.config.apiInterval || 300;
        this.room = this.config.room || "Solar Dashboard";

        // Cache for accessories
        this.accessories = new Map();

        // Define all metrics here.
        // Battery is now treated exactly like the others (LightSensor).
        this.metrics = [
            { name: "PV Power kW", idTag: "pvPower" },
            { name: "Battery Power kW", idTag: "batteryPower" },
            { name: "Battery Percentage", idTag: "batteryPercent" },
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

        if (!this.apiKey || !this.apiSecret || !this.deviceId) {
            this.log.error("Missing required config: apiKey, apiSecret, deviceId");
            return;
        }

        this.api.on("didFinishLaunching", () => {
            this.log.info(`[Solis] Platform launched — initializing accessories`);
            this.initAccessories();
            this.startPolling();
        });
    }

    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    initAccessories() {
        // 1. Create or Restore accessories for all metrics
        for (const metric of this.metrics) {
            this.createOrRestoreAccessory(metric.name, metric.idTag);
        }

        // 2. Cleanup: Remove accessories that are no longer in our metrics list
        const activeUUIDs = this.metrics.map(m =>
            this.api.hap.uuid.generate(`solis-${this.deviceId}-${m.idTag}`)
        );

        for (const [uuid, accessory] of this.accessories) {
            if (!activeUUIDs.includes(uuid)) {
                this.log.warn(`[Solis] Removing obsolete accessory: ${accessory.displayName}`);
                this.api.unregisterPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
                this.accessories.delete(uuid);
            }
        }
    }

    createOrRestoreAccessory(name, idTag) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        let accessory = this.accessories.get(uuid);

        if (!accessory) {
            // Create new
            accessory = new this.api.platformAccessory(name, uuid);

            // Info Service
            accessory.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Name, name)
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, "Metric Sensor")
                .setCharacteristic(Characteristic.SerialNumber, `${this.deviceId}-${idTag}`);

            // Add Service (LightSensor for all metrics)
            accessory.addService(Service.LightSensor, name, idTag);

            accessory.context.room = this.room;
            this.api.registerPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
            this.log.info(`[Solis] Created accessory: ${name}`);
        } else {
            // Ensure name is up to date
            accessory.displayName = name;

            // Ensure the service exists
            const service = this.getServiceBySubtype(accessory, Service.LightSensor, idTag);
            if (!service) {
                this.log.warn(`[Solis] Fixing service type for ${name}`);
                // Remove old services if any exist
                accessory.services.forEach(s => {
                    if (s.UUID !== Service.AccessoryInformation.UUID) {
                        accessory.removeService(s);
                    }
                });
                accessory.addService(Service.LightSensor, name, idTag);
            }
        }

        this.accessories.set(uuid, accessory);
    }

    startPolling() {
        this.updateAllSensors();
        setInterval(() => this.updateAllSensors(), this.apiInterval * 1000);
    }

    async updateAllSensors() {
        try {
            const response = await this.solisRequest("/v1/api/stationDetailList", { deviceId: this.deviceId });

            // Check for logical success as well as API success
            if (!response?.success || response.code !== '0' || !response.data?.records?.length) {
                this.log.warn("[Solis] No valid data returned from API", response?.msg || "");
                return;
            }

            const r = response.data.records[0];
            const safe = (n, fallback = 0) => (typeof n === "number" && !isNaN(n) ? n : Number(n) || fallback);

            // Prepare Data Map
            const dataMap = {
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
                dayHouseLoadEnergy: safe(r.homeLoadTodayEnergy)
            };

            const timestamp = new Date(safe(r.dataTimestamp, Date.now())).toLocaleString();

            // 1. Update Sensor Values
            for (const metric of this.metrics) {
                const val = dataMap[metric.idTag];
                if (val !== undefined) {
                    this.updateLightSensor(metric.idTag, val);
                }
            }

            this.log.debug(`[Solis] Updated sensors. Timestamp: ${timestamp}. Details ${dataMap}`);

        } catch (err) {
            this.log.error("[Solis] updateAllSensors failed:", err.message || err);
        }
    }

    updateLightSensor(idTag, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const service = this.getServiceBySubtype(accessory, Service.LightSensor, idTag);
        if (!service) return;

        // LightSensor cannot be 0 in HomeKit logic usually, min is 0.0001
        const safeValue = Math.max(0.0001, Number(value));

        this.safeUpdate(service, Characteristic.CurrentAmbientLightLevel, safeValue);
    }

    // --- Helpers ---
    getServiceBySubtype(accessory, serviceType, subtype) {
        if (accessory.getServiceById) {
            return accessory.getServiceById(serviceType, subtype);
        }
        return accessory.services.find(s => s.UUID === serviceType.UUID && s.subtype === subtype)
            || accessory.getService(serviceType);
    }

    safeUpdate(service, charType, value) {
        let characteristic = service.getCharacteristic(charType);
        if (!characteristic) {
            characteristic = service.addCharacteristic(charType);
        }
        if (characteristic.value !== value) {
            characteristic.updateValue(value);
        }
    }

    async solisRequest(path, bodyObject) {
        const body = JSON.stringify(bodyObject);
        const contentMD5 = crypto.createHash("md5").update(body, "utf8").digest("base64");
        const date = new Date().toUTCString();
        const signStr = `POST\n${contentMD5}\napplication/json\n${date}\n${path}`;
        const sign = crypto.createHmac("sha1", Buffer.from(this.apiSecret, "utf8")).update(signStr, "utf8").digest("base64");

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
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        return res.json();
    }
}