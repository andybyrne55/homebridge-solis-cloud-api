const crypto = require("crypto");
const fetch = require("node-fetch");

let Service, Characteristic;

// -----------------------------------------------------------------------------
// PLATFORM REGISTRATION (REQUIRED BY HOMEBRIDGE)
// -----------------------------------------------------------------------------
// Homebridge calls this once during plugin load. You *must*:
// - Extract HAP Service and Characteristic
// - Register the platform class
// -----------------------------------------------------------------------------
module.exports = (homebridge) => {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    homebridge.registerPlatform("homebridge-solis-cloud-api", "SolisCloudAPI", SolisCloudPlatform, true);
};

// -----------------------------------------------------------------------------
// PLATFORM CLASS (Homebridge constructs this)
// -----------------------------------------------------------------------------
class SolisCloudPlatform {

    // -------------------------------------------------------------------------
    // REQUIRED BY HOMEBRIDGE.
    // Homebridge creates your platform instance with logging, config, and API.
    // You MUST store these and prepare for accessory loading.
    // -------------------------------------------------------------------------
    constructor(log, config, api) {
        this.log = log;
        this.config = config || {};
        this.api = api;

        // --- USER CONFIGURATION ---
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
            this.log.info(`[Solis] Platform launched — initializing accessories...`);

            this.initialiseAccessories();
            this.startPollingLoop();
        });
    }

    // -------------------------------------------------------------------------
    // REQUIRED BY HOMEBRIDGE.
    // Called once for every cached accessory restored from disk.
    // You MUST store the accessory for later retrieval.
    // -------------------------------------------------------------------------
    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    // -------------------------------------------------------------------------
    // Dynamic platforms must:
    //   - Create new accessories if missing
    //   - Restore existing accessories
    //   - Remove accessories no longer needed
    // -------------------------------------------------------------------------
    initialiseAccessories() {
        const validUUIDs = [];

        for (const metric of this.metrics) {
            const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${metric.idTag}`);
            validUUIDs.push(uuid);
            this.ensureAccessory(metric.name, metric.idTag, uuid);
        }

        // Remove accessories that do not belong to current metrics
        for (const [uuid, accessory] of this.accessories) {
            if (!validUUIDs.includes(uuid)) {
                this.log.warn(`[Solis] Removing obsolete accessory: ${accessory.displayName}`);
                this.api.unregisterPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
                this.accessories.delete(uuid);
            }
        }

        this.log.info(`[Solis] Platform launched — accessories initialised`);
    }

    // -------------------------------------------------------------------------
    // Creates or restores a LightSensor accessory for a metric.
    // -------------------------------------------------------------------------
    ensureAccessory(name, idTag, uuid) {
        let accessory = this.accessories.get(uuid);

        if (!accessory) {
            // Create new accessory
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
            // Restore accessory and ensure correct service
            accessory.displayName = name;

            const service = this.getServiceBySubtype(accessory, Service.LightSensor, idTag);
            if (!service) {
                this.log.warn(`[Solis] Fixing service type for ${name}`);
                // Remove old services if any exist (keep AccessoryInformation)
                accessory.getServices().forEach(s => {
                    if (s.UUID !== Service.AccessoryInformation.UUID) {
                        try { accessory.removeService(s); } catch (e) { /* ignore */ }
                    }
                });
                accessory.addService(Service.LightSensor, name, idTag);
            }
        }

        this.accessories.set(uuid, accessory);
    }

    // -------------------------------------------------------------------------
    // Custom logic: periodically fetch API data and update sensors.
    // -------------------------------------------------------------------------
    startPollingLoop() {
        this.updateAllSensors(); // Run once immediately, then on interval
        setInterval(() => this.updateAllSensors(), this.apiInterval * 1000);
    }

    // -------------------------------------------------------------------------
    // Fetches Solis API data and updates all LightSensor services.
    // -------------------------------------------------------------------------
    async updateAllSensors() {
        try {
            const response = await this.solisRequest("/v1/api/stationDetailList", { deviceId: this.deviceId });

            if (!response?.success || response.code !== '0' || !response.data?.records?.length) {
                this.log.warn("[Solis] Invalid data returned from API", response?.msg || "");
                return;
            }

            const r = response.data.records[0];
            const safe = (n, fallback = 0) => (typeof n === "number" && !isNaN(n) ? n : Number(n) || fallback);

            // Prepare Data Map
            const dataMap = {
                pvPower: safe(r.power), // e.g. 0.000
                batteryPower: safe(r.batteryPower), // e.g. 0.000
                batteryPercent: safe(r.batteryPercent), // e.g. 18.0
                gridImport: r.psum < 0 ? Math.abs(safe(r.psum)) : 0, // e.g. -0.380
                gridExport: r.psum > 0 ? safe(r.psum) : 0, // e.g. -0.380
                houseLoad: safe(r.familyLoadPower), // e.g. 0.380
                dayPvEnergy: safe(r.dayEnergy), // e.g. 5.200
                monthPvEnergy: safe(r.monthEnergy), // e.g. 112.500
                yearPvEnergy: safe(r.yearEnergy), // e.g. 216.100
                totalPvEnergy: safe(r.allEnergy), // e.g. 216.100
                dayGridPurchased: safe(r.gridPurchasedDayEnergy), // e.g. 14.290
                dayGridSold: safe(r.gridSellDayEnergy), // e.g. 0.070
                dayHouseLoadEnergy: safe(r.homeLoadTodayEnergy) // e.g. 19.420
            };

            const timestamp = new Date(safe(r.dataTimestamp, Date.now())).toLocaleString();

            // 1. Update Sensor Values
            for (const metric of this.metrics) {
                const val = dataMap[metric.idTag];
                if (val !== undefined) {
                    this.updateLightSensor(metric.idTag, val);
                }
            }

            this.log.debug(`[Solis] Updated sensors. Timestamp: ${timestamp}. Details ${JSON.stringify(dataMap)}`);

        } catch (err) {
            this.log.error("[Solis] updateAllSensors failed:", err.message || err);
        }
    }

    // -------------------------------------------------------------------------
    // Pushes the value into the appropriate HomeKit service.
    // -------------------------------------------------------------------------
    updateLightSensor(idTag, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const service = this.getServiceBySubtype(accessory, Service.LightSensor, idTag);
        if (!service) return;

        // Parse number safely
        const parsed = isFinite(Number(value)) ? Number(value) : NaN;
        const fallbackVal = 0.0001;
        const numeric = isFinite(parsed) ? parsed : fallbackVal;

        // Clamp to HomeKit LightSensor allowed range: [0.0001, 100000]
        const safeValue = Math.min(Math.max(0.0001, numeric), 100000);

        this.safeUpdate(service, Characteristic.CurrentAmbientLightLevel, safeValue);
    }

    // -------------------------------------------------------------------------
    // Helper for retrieving services.
    // Robustly tries accessory.getService(type, subtype) then falls back to scanning.
    // -------------------------------------------------------------------------
    getServiceBySubtype(accessory, serviceType, subtype) {
        try {
            // Preferred: some Homebridge versions support (type, subtype)
            if (typeof accessory.getService === 'function') {
                const svc = accessory.getService(serviceType, subtype);
                if (svc) return svc;
            }
        } catch (e) {
            // ignore and fallback to scanning
        }

        // Fallback: scan getServices() for exact subtype match
        const services = accessory.getServices ? accessory.getServices() : [];
        let found = services.find(s => s.UUID === serviceType.UUID && s.subtype === subtype);
        if (found) return found;

        // Last resort: return first matching serviceType (not ideal but safer than nothing)
        return services.find(s => s.UUID === serviceType.UUID) || null;
    }

    // -------------------------------------------------------------------------
    // Ensures characteristics update only when value changed.
    //--------------------------------------------------------------------------
    safeUpdate(service, charType, value) {
        let characteristic = service.getCharacteristic(charType);
        if (!characteristic) {
            characteristic = service.addCharacteristic(charType);
        }
        if (characteristic.value !== value) {
            characteristic.updateValue(value);
        }
    }

    // -------------------------------------------------------------------------
    // Handles the Solis API authenticated POST request.
    // -------------------------------------------------------------------------
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