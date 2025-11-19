const crypto = require("crypto");
const fetch = require("node-fetch");

let Service, Characteristic, FakeGatoHistoryService;

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

    FakeGatoHistoryService = require("fakegato-history")(homebridge);

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

        // User Configuration
        this.apiKey = this.config.apiKey;
        this.apiSecret = this.config.apiSecret;
        this.deviceId = this.config.deviceId;
        this.baseUrl = this.config.baseUrl || "https://www.soliscloud.com:13333";
        this.apiInterval = this.config.apiInterval || 300;

        this.accessories = new Map();

        // Define metrics.
        // Added 'graph: true' to instantaneous values we want to plot.
        this.metrics = [
            { name: "PV Power Watts", idTag: "pvPower", graph: true },
            { name: "Battery Power Watts", idTag: "batteryPower", graph: true },
            { name: "Battery Percentage", idTag: "batteryPercent", graph: true }, // Will graph as 'W' in Eve, but visually useful
            { name: "Grid Import Watts", idTag: "gridImport", graph: true },
            { name: "Grid Export Watts", idTag: "gridExport", graph: true },
            { name: "House Load Watts", idTag: "houseLoad", graph: true },

            // Cumulative totals usually shouldn't be graphed as instantaneous 'power' lines
            { name: "PV Today Energy kWh", idTag: "dayPvEnergy", graph: false },
            { name: "PV Month Energy kWh", idTag: "monthPvEnergy", graph: false },
            { name: "PV Year Energy kWh", idTag: "yearPvEnergy", graph: false },
            { name: "PV Total Energy kWh", idTag: "totalPvEnergy", graph: false },
            { name: "Grid Purchased Today kWh", idTag: "dayGridPurchased", graph: false },
            { name: "Grid Sold Today kWh", idTag: "dayGridSold", graph: false },
            { name: "House Load Today kWh", idTag: "dayHouseLoadEnergy", graph: false }
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
            this.ensureAccessory(metric, uuid);
        }

        // Remove accessories that do not belong to current metrics
        for (const [uuid, accessory] of this.accessories) {
            if (!validUUIDs.includes(uuid)) {
                this.log.warn(`[Solis] Removing obsolete accessory: ${accessory.displayName}`);
                this.api.unregisterPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
                this.accessories.delete(uuid);
            }
        }
        this.log.info(`[Solis] Accessories initialised`);
    }

    // -------------------------------------------------------------------------
    // Creates/Restores Accessory + Setup FakeGato
    // -------------------------------------------------------------------------
    ensureAccessory(metric, uuid) {
        let accessory = this.accessories.get(uuid);

        // 1. Create the accessory if it doesn't exist
        if (!accessory) {
            accessory = new this.api.platformAccessory(metric.name, uuid);

            accessory.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Name, metric.name)
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, "Metric Sensor")
                .setCharacteristic(Characteristic.SerialNumber, `${this.deviceId}-${metric.idTag}`);

            // Initialize the context object if missing (safe place to store variables)
            accessory.context = {};

            // Add the new service
            accessory.addService(Service.LightSensor, metric.name, metric.idTag);

            this.api.registerPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
            this.log.info(`[Solis] Created accessory: ${metric.name}`);
        }
        else {
            // 2. Existing Accessory: Update details
            accessory.displayName = metric.name;

            // Ensure context exists
            accessory.context = accessory.context || {};

            // Check if the specific LightSensor service exists
            const existingService = accessory.getServiceByUUIDAndSubType(Service.LightSensor, metric.idTag);
            if (!existingService) {
                this.log.warn(`[Solis] Repairing service for ${metric.name}`);
                const oldService = accessory.getService(Service.LightSensor);
                if (oldService) {
                    accessory.removeService(oldService);
                }

                // Add the fresh service
                accessory.addService(Service.LightSensor, metric.name, metric.idTag);
            }
        }

        this.accessories.set(uuid, accessory);

        // 3. FakeGato Setup
        if (metric.graph) {
            // Only create if it doesn't already exist on the accessory object
            if (!accessory.historyService) {
                this.log.debug(`[Solis] Initialising FakeGato for ${metric.name}`);
                accessory.historyService = new FakeGatoHistoryService("custom", accessory, {
                    storage: 'fs',
                    log: this.log
                });
            }
        }
    }

    // -------------------------------------------------------------------------
    // Custom logic: periodically fetch API data and update sensors.
    // -------------------------------------------------------------------------
    startPollingLoop() {
        this.updateAllSensors();
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
            const safe = (n, fallback = 0) => {
                const val = Number(n);
                return isNaN(val) ? fallback : val;
            };

            // Prepare Data Map
            const dataMap = {
                pvPower: safe(r.power) * 1000, // e.g. raw data is 0.000
                batteryPower: safe(r.batteryPower) * 1000, // e.g. raw data is 0.000
                batteryPercent: safe(r.batteryPercent), // e.g. raw data is 18.0
                gridImport: r.psum < 0 ? Math.abs(safe(r.psum))  * 1000 : 0, // e.g. raw data is -0.380
                gridExport: r.psum > 0 ? safe(r.psum)  * 1000 : 0, // e.g. raw data is -0.380
                houseLoad: safe(r.familyLoadPower) * 1000, // e.g. raw data is 0.380
                dayPvEnergy: safe(r.dayEnergy), // e.g. raw data is 5.200
                monthPvEnergy: safe(r.monthEnergy), // e.g. raw data is 112.500
                yearPvEnergy: safe(r.yearEnergy), // e.g. raw data is 216.100
                totalPvEnergy: safe(r.allEnergy), // e.g. raw data is 216.100
                dayGridPurchased: safe(r.gridPurchasedDayEnergy), // e.g. raw data is 14.290
                dayGridSold: safe(r.gridSellDayEnergy), // e.g. raw data is 0.070
                dayHouseLoadEnergy: safe(r.homeLoadTodayEnergy) // e.g. raw data is 19.420
            };

            const dataTimestampMillis = safe(r.dataTimestamp, Date.now())

            // Update Sensor Values
            for (const metric of this.metrics) {
                const val = dataMap[metric.idTag];
                if (val !== undefined) {
                    this.updateLightSensor(metric, val, dataTimestampMillis);
                }
            }

            const timestamp = new Date(dataTimestampMillis).toLocaleString();
            this.log.debug(`[Solis] Updated sensors. Timestamp: ${timestamp}. Details ${JSON.stringify(dataMap)}`);
        } catch (err) {
            this.log.error("[Solis] updateAllSensors failed:", err.message || err);
        }
    }

    // -------------------------------------------------------------------------
    // Pushes the value into the appropriate HomeKit service.
    // -------------------------------------------------------------------------
    updateLightSensor(metric, value, dataTimestampMillis) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${metric.idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const service = this.getServiceBySubtype(accessory, Service.LightSensor, metric.idTag);
        if (!service) return;

        // Parse number safely
        const parsed = isFinite(Number(value)) ? Number(value) : NaN;
        const numeric = isFinite(parsed) ? parsed : 0.0001; // Fallback to tiny value, not 0

        // 2. Update HomeKit Instantaneous Value (The big number on the tile)
        // We update this regardless of timestamp, just in case the UI is out of sync
        const safeValue = Math.min(Math.max(0.0001, numeric), 100000);
        this.safeUpdate(service, Characteristic.CurrentAmbientLightLevel, safeValue);

        // 3. Push to FakeGato
        if (metric.graph && accessory.historyService) {
            const entryTime = Math.round(dataTimestampMillis / 1000);
            // specific context for this metric to track the last log time
            accessory.context.logging = accessory.context.logging || {};
            const lastTime = accessory.context.logging[metric.idTag] || 0;

            // ONLY log if the new data is newer than the last logged data to prevent duplicate or invalid entries
            if (entryTime > lastTime) {
                this.log.debug(`[Solis] Logging ${metric.name}: ${numeric} (Time: ${entryTime})`);
                accessory.historyService.addEntry({
                    time: entryTime,
                    lux: numeric
                });

                // Update our memory so we don't log this timestamp again
                accessory.context.logging[metric.idTag] = entryTime;
            } else {
                this.log.debug(`[Solis] Skipping duplicate/stale data for ${metric.name}`);
            }
        }
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
        } catch (e) {}

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