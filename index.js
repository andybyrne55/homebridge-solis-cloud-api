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
        this.sensorInterval = this.config.sensorInterval || 60; // (unused; kept if you want separate)

        this.accessories = new Map(); // UUID -> accessory
        this.cache = {};

        if (!this.apiKey || !this.apiSecret || !this.deviceId) {
            this.log.error("Missing required config: apiKey, apiSecret, deviceId");
            return;
        }

        // Allow Homebridge to restore cached accessories
        this.api.on("didFinishLaunching", () => {
            this.log.info("[Solis] Platform launched — initialising accessories");
            this.initAccessories();
            this.startPolling();
        });
    }

    // Called by Homebridge for cached accessories
    configureAccessory(accessory) {
        this.log.debug(`[Solis] configureAccessory: ${accessory.displayName} (${accessory.UUID})`);
        this.accessories.set(accessory.UUID, accessory);
    }

    //
    // --- CUSTOM CHARACTERISTIC FACTORIES ---
    //
    createNumericCharacteristic(name, uuid, min = 0, max = 1000000, step = 0.01, unit = null) {
        const CharClass = class extends Characteristic {
            constructor() {
                super(name, uuid);
                const props = {
                    format: Characteristic.Formats.FLOAT,
                    perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY],
                };
                if (unit) props.unit = unit;
                props.minValue = min;
                props.maxValue = max;
                props.minStep = step;
                this.setProps(props);
            }
        };
        return CharClass;
    }

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
    // Helper to create or restore an accessory and ensure names are set
    //
    createOrRestoreAccessory({ name, idTag, serviceType, primaryCharacteristic, customCharacteristicClass = null }) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        let accessory = this.accessories.get(uuid);

        if (!accessory) {
            accessory = new this.api.platformAccessory(name, uuid);

            // AccessoryInformation -> Name
            accessory.getService(Service.AccessoryInformation)
                .setCharacteristic(Characteristic.Name, name)
                .setCharacteristic(Characteristic.Manufacturer, "Solis")
                .setCharacteristic(Characteristic.Model, serviceType?.name || "Sensor")
                .setCharacteristic(Characteristic.SerialNumber, this.deviceId);

            // Primary service
            const service = accessory.addService(serviceType, name, idTag);
            service.setCharacteristic(Characteristic.Name, name);

            if (customCharacteristicClass) {
                // add custom characteristic to the service (e.g. string timestamp)
                service.addCharacteristic(customCharacteristicClass);
            }

            // register with homebridge so it's visible and cached
            this.api.registerPlatformAccessories("homebridge-solis-cloud-api", "SolisCloudAPI", [accessory]);
            this.log.info(`[Solis] Created accessory: ${name}`);
        } else {
            // Ensure names are set on restored accessory (in case previous cache lacked them)
            accessory.displayName = name;
            const svc = accessory.getService(serviceType) || accessory.getServiceById(serviceType, idTag);
            if (svc) svc.setCharacteristic(Characteristic.Name, name);
        }

        this.accessories.set(uuid, accessory);
        return accessory;
    }

    //
    // Create every accessory you need (names + service types)
    //
    initAccessories() {
        // Power metrics (kW) - expose as LightSensor (numeric)
        this.createOrRestoreAccessory({ name: "PV Power", idTag: "pvPower", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "Battery Power", idTag: "batteryPower", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "Grid Import", idTag: "gridImport", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "Grid Export", idTag: "gridExport", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "House Load", idTag: "houseLoad", serviceType: Service.LightSensor });

        // Energy totals (kWh) — also expose as numeric LightSensor (HomeKit lacks a native energy sensor)
        this.createOrRestoreAccessory({ name: "PV Today Energy", idTag: "dayPvEnergy", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "PV Month Energy", idTag: "monthPvEnergy", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "PV Year Energy", idTag: "yearPvEnergy", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "PV Total Energy", idTag: "totalPvEnergy", serviceType: Service.LightSensor });

        this.createOrRestoreAccessory({ name: "Grid Purchased Today", idTag: "dayGridPurchased", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "Grid Sold Today", idTag: "dayGridSold", serviceType: Service.LightSensor });
        this.createOrRestoreAccessory({ name: "House Load Today", idTag: "dayHouseLoadEnergy", serviceType: Service.LightSensor });

        // Battery percentage — use BatteryService (proper HomeKit battery UI)
        this.createOrRestoreAccessory({ name: "Battery Level", idTag: "batteryPercent", serviceType: Service.BatteryService });

        // Data timestamp — small stateless switch service with custom string char
        const dataTsCharClass = this.createStringCharacteristic("Data Timestamp", "e2b6f0ff-1234-4a56-90ab-cdef123456ff");
        this.createOrRestoreAccessory({
            name: "Solis Data Timestamp",
            idTag: "dataTimestamp",
            serviceType: Service.StatelessProgrammableSwitch,
            customCharacteristicClass: dataTsCharClass
        });
    }

    //
    // Polling
    //
    startPolling() {
        this.updateAllSensors(); // initial
        setInterval(() => this.updateAllSensors(), this.apiInterval * 1000);
    }

    //
    // Build and sign API request, call Solis
    //
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
            this.log.error("[Solis] Request failed:", err.message);
            throw err;
        }
    }

    //
    // Central update — fetch once and update all accessories
    //
    async updateAllSensors() {
        try {
            const response = await this.solisRequest("/v1/api/stationDetailList", { deviceId: this.deviceId });

            if (!response?.success || !response.data?.records?.length) {
                this.log.warn("[Solis] No data returned from API");
                return;
            }

            const r = response.data.records[0];

            const safe = (n, fallback = 0) => (typeof n === "number" && !isNaN(n) ? n : Number(n) || fallback);

            // build cache with all metrics present previously
            this.cache = {
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

            // update each sensor/service
            this.setLightSensorValue("pvPower", this.cache.pvPower);
            this.setLightSensorValue("batteryPower", this.cache.batteryPower);
            this.setLightSensorValue("gridImport", this.cache.gridImport);
            this.setLightSensorValue("gridExport", this.cache.gridExport);
            this.setLightSensorValue("houseLoad", this.cache.houseLoad);

            this.setLightSensorValue("dayPvEnergy", this.cache.dayPvEnergy);
            this.setLightSensorValue("monthPvEnergy", this.cache.monthPvEnergy);
            this.setLightSensorValue("yearPvEnergy", this.cache.yearPvEnergy);
            this.setLightSensorValue("totalPvEnergy", this.cache.totalPvEnergy);

            this.setLightSensorValue("dayGridPurchased", this.cache.dayGridPurchased);
            this.setLightSensorValue("dayGridSold", this.cache.dayGridSold);
            this.setLightSensorValue("dayHouseLoadEnergy", this.cache.dayHouseLoadEnergy);

            this.setBatteryLevel("batteryPercent", this.cache.batteryPercent);

            this.setDataTimestamp("dataTimestamp", this.cache.dataTimestamp);

            this.log.debug("[Solis] Sensors updated:", this.cache);
        } catch (err) {
            this.log.error("[Solis] updateAllSensors failed:", err.message || err);
        }
    }

    //
    // Helpers to set specific service characteristics
    //
    setLightSensorValue(idTag, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        // HomeKit's CurrentAmbientLightLevel must be > 0; use tiny value for 0
        const safeValue = (typeof value === "number" && value === 0) ? 0.0001 : value;
        const service = accessory.getService(Service.LightSensor);
        if (!service) return;

        service.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, safeValue);
    }

    setBatteryLevel(idTag, value) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
        const service = accessory.getService(Service.BatteryService);
        if (!service) return;

        service.updateCharacteristic(Characteristic.BatteryLevel, safeValue);
        // Optionally update ChargingState / StatusLowBattery if you have logic
        const isLow = safeValue < 20;
        service.updateCharacteristic(Characteristic.StatusLowBattery, isLow ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
    }

    setDataTimestamp(idTag, str) {
        const uuid = this.api.hap.uuid.generate(`solis-${this.deviceId}-${idTag}`);
        const accessory = this.accessories.get(uuid);
        if (!accessory) return;

        // Find the stateless switch service and its custom string char (if present)
        const service = accessory.getService(Service.StatelessProgrammableSwitch);
        if (!service) return;

        // Attempt to find the custom char by uuid; if not present, fallback to EventCharacteristic
        // We saved the custom string char in the service when creating the accessory.
        const chars = service.characteristics || [];
        const strChar = chars.find(c => String(c.UUID).toLowerCase().startsWith("e2b6f0ff"));
        if (strChar) {
            service.updateCharacteristic(strChar.UUID, str);
        } else {
            // fallback: update Programmable Switch Event as a string-ish notification (not ideal)
            // Use the default notify characteristic with timestamp as integer (ms)
            service.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, Date.now());
        }
    }
}
