const crypto = require("crypto");
const fetch = require("node-fetch");
const fs = require("fs"); // Required by fakegato internally

let Service, Characteristic;
let FakeGatoHistoryService;

// -----------------------------------------------------------------------------
// CUSTOM EVE CHARACTERISTICS
const EVE_POWER_CONSUMPTION_UUID = "E863F10D-079E-48FF-8F27-9C2605A29F52";

// Wrapper class required by HomeKit/HAP to avoid UUID errors
class EvePowerConsumptionCharacteristic extends Characteristic {
    constructor() {
        super('Power Consumption', EVE_POWER_CONSUMPTION_UUID);
        this.setProps({
            format: Characteristic.Formats.FLOAT,
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
            minValue: 0,
            maxValue: 65535,
            minStep: 0.1
        });
        this.value = 0;
    }
}

// Required to trigger the "Power" graph UI in the Eve App
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// PLATFORM REGISTRATION
// -----------------------------------------------------------------------------
module.exports = (homebridge) => {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    // Load FakeGato with the Homebridge API instance
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

        // --- USER CONFIGURATION ---
        this.apiKey = this.config.apiKey;
        this.apiSecret = this.config.apiSecret;
        this.deviceId = this.config.deviceId;
        this.baseUrl = this.config.baseUrl || "https://www.soliscloud.com:13333";
        this.apiInterval = this.config.apiInterval || 300;

        this.accessories = new Map();

        // Define metrics.
        // Added 'graph: true' to instantaneous values we want to plot.
        this.metrics = [
            { name: "PV Power Watts", idTag: "pvPower", graph: false },
            { name: "Battery Power Watts", idTag: "batteryPower", graph: false },
            { name: "Battery Percentage", idTag: "batteryPercent", graph: false }, // Will graph as 'W' in Eve, but visually useful
            { name: "Grid Import Watts", idTag: "gridImport", graph: false },
            { name: "Grid Export Watts", idTag: "gridExport", graph: false },
            { name: "House Load Watts", idTag: "houseLoad", graph: false },

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

        if (!accessory) {
            accessory = new this.api.platformAccessory(metric.name, uuid);

            accessory.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Name, metric.name)
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, "Metric Sensor")
                .setCharacteristic(Characteristic.SerialNumber, `${this.deviceId}-${metric.idTag}`);

            accessory.addService(Service.LightSensor, metric.name, metric.idTag); // light sensor for all metrics

            this.api.registerPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
            this.log.info(`[Solis] Created accessory: ${metric.name}`);
        } else {
            accessory.displayName = metric.name;
            const service = this.getServiceBySubtype(accessory, Service.LightSensor, metric.idTag);
            if (!service) {
                this.log.warn(`[Solis] Fixing service type for ${metric.name}`);
                // Remove old services if any exist (keep AccessoryInformation)
                accessory.getServices().forEach(s => {
                    if (s.UUID !== Service.AccessoryInformation.UUID) {
                        try { accessory.removeService(s); } catch (e) {}
                    }
                });
                accessory.addService(Service.LightSensor, metric.name, metric.idTag);
            }
        }

        // FAKEGATO SETUP
        if (metric.graph) {
            // 1. Ensure the Custom Eve Characteristic exists on the service
            // Eve needs "Current Consumption" (UUID E863F10D...) to render the graph line properly
            const service = this.getServiceBySubtype(accessory, Service.LightSensor, metric.idTag);
            if (service) {
                if (!service.testCharacteristic(EvePowerConsumptionCharacteristic)) {
                    service.addCharacteristic(EvePowerConsumptionCharacteristic);
                }
            }

            // 2. Initialize the History Service
            // We use 'energy' type because it supports power graphs
            accessory.context.loggingService = new FakeGatoHistoryService("energy", accessory, {
                storage: 'fs',
                log: this.log,
                disableTimer: true // We will push entries manually when we fetch data
            });
        }

        this.accessories.set(uuid, accessory);
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
            const safe = (n, fallback = 0) => (typeof n === "number" && !isNaN(n) ? n : Number(n) || fallback);

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

            const timestamp = new Date(safe(r.dataTimestamp, Date.now())).toLocaleString();

            // Update Sensor Values
            for (const metric of this.metrics) {
                const val = dataMap[metric.idTag];
                if (val !== undefined) {
                    this.updateLightSensor(metric, val);
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
    updateLightSensor(metric, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${metric.idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const service = this.getServiceBySubtype(accessory, Service.LightSensor, metric.idTag);
        if (!service) return;

        // Parse number safely
        const parsed = isFinite(Number(value)) ? Number(value) : NaN;
        const fallbackVal = 0.0001;
        const numeric = isFinite(parsed) ? parsed : fallbackVal;

        // 1. Update HomeKit LightSensor (Lux)
        const safeValue = Math.min(Math.max(0.0001, numeric), 100000);
        this.safeUpdate(service, Characteristic.CurrentAmbientLightLevel, safeValue);

        // 2. Update Eve History (Graphs)
        // Only if this metric is flagged for graphing (Watts / %)
        if (metric.graph && accessory.context.loggingService) {
            // Update the Custom Eve Characteristic (required for live view in Eve)
            this.safeUpdate(service, EvePowerConsumptionCharacteristic, numeric);

            // Add entry to history
            // Fakegato 'energy' type expects { power: 123 }
            accessory.context.loggingService.addEntry({
                time: Math.round(new Date().valueOf() / 1000),
                power: numeric
            });
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