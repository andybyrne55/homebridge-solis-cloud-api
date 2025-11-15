# homebridge-solis-cloud-api
Homebridge Plugin To Fetch Data From Solis API

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