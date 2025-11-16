#!/bin/bash

# -------------------------------
# CONFIG
# -------------------------------
API_KEY="YOUR_API_KEY_HERE"
API_SECRET="YOUR_API_SECRET_HERE"
BASE_URL="https://www.soliscloud.com:13333"

STATION_LIST_PATH="/v1/api/userStationList"
INVERTER_LIST_PATH="/v1/api/inverterList"
DETAIL_PATH="/v1/api/stationDetailList"

# -------------------------------
# HELPERS
# -------------------------------
gmt_date() {
  date -u +"%a, %d %b %Y %H:%M:%S GMT"
}

generate_signature() {
  local method=$1
  local content_md5=$2
  local content_type="application/json"
  local date=$3
  local path=$4
  local string_to_sign="$method
$content_md5
$content_type
$date
$path"
  echo -n "$string_to_sign" | openssl dgst -sha1 -hmac "$API_SECRET" -binary | base64
}

# -------------------------------
# STEP 1: FETCH STATION LIST
# -------------------------------
GMT_DATE=$(gmt_date)
BODY_STATIONS='{"pageNo":1,"pageSize":20}'

CONTENT_MD5_STATIONS=$(echo -n "$BODY_STATIONS" | md5 -r | xxd -r -p | base64)
SIGNATURE_STATIONS=$(generate_signature "POST" "$CONTENT_MD5_STATIONS" "$GMT_DATE" "$STATION_LIST_PATH")

echo "➡️ Fetching station list..."
RESPONSE_STATIONS=$(curl -s -X POST "$BASE_URL$STATION_LIST_PATH" \
  -H "Content-Type: application/json;charset=UTF-8" \
  -H "Authorization: API $API_KEY:$SIGNATURE_STATIONS" \
  -H "Content-MD5: $CONTENT_MD5_STATIONS" \
  -H "Date: $GMT_DATE" \
  -d "$BODY_STATIONS")

if [[ -z "$RESPONSE_STATIONS" ]]; then
  echo "❌ No response from server! Check network/API endpoint."
  exit 1
fi

SUCCESS_STATIONS=$(echo "$RESPONSE_STATIONS" | jq -r '.success')
if [[ "$SUCCESS_STATIONS" != "true" ]]; then
  echo "❌ Failed to fetch station list:"
  echo "$RESPONSE_STATIONS" | jq
  exit 1
fi

STATION_IDS=($(echo "$RESPONSE_STATIONS" | jq -r '.data.page.records[].id'))
if [[ ${#STATION_IDS[@]} -eq 0 ]]; then
  echo "❌ No stations found!"
  exit 1
fi
echo "✅ Found ${#STATION_IDS[@]} station(s): ${STATION_IDS[*]}"

# -------------------------------
# STEP 2: FETCH DEVICES (INVERTERS) FOR EACH STATION
# -------------------------------
declare -a DEVICE_IDS

for STATION_ID in "${STATION_IDS[@]}"; do
  GMT_DATE=$(gmt_date)

  BODY_INVERTER="{\"pageNo\":1,\"pageSize\":20,\"stationId\":$STATION_ID}"

  CONTENT_MD5_INVERTER=$(echo -n "$BODY_INVERTER" | md5 -r | xxd -r -p | base64)
  SIGNATURE_INVERTER=$(generate_signature "POST" "$CONTENT_MD5_INVERTER" "$GMT_DATE" "$INVERTER_LIST_PATH")

  echo "➡️ Fetching devices for station id $STATION_ID..."
  RESPONSE_INVERTER=$(curl -s -X POST "$BASE_URL$INVERTER_LIST_PATH" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -H "Authorization: API $API_KEY:$SIGNATURE_INVERTER" \
    -H "Content-MD5: $CONTENT_MD5_INVERTER" \
    -H "Date: $GMT_DATE" \
    -d "$BODY_INVERTER")

  echo "DEBUG: inverterList response: $RESPONSE_INVERTER"

  SUCCESS_INVERTER=$(echo "$RESPONSE_INVERTER" | jq -r '.success // .code')

  if [[ "$SUCCESS_INVERTER" != "true" && "$SUCCESS_INVERTER" != "0" ]]; then
    echo "❌ Failed to fetch devices for station id $STATION_ID:"
    echo "$RESPONSE_INVERTER" | jq
    continue
  fi

  # Correct path for device IDs
  IDS=($(echo "$RESPONSE_INVERTER" | jq -r '.data.page.records[] | .inverterId'))
  if [[ ${#IDS[@]} -eq 0 ]]; then
    echo "⚠️ No devices found for station id $STATION_ID"
    continue
  fi

  echo "✅ Found ${#IDS[@]} device(s) for station id $STATION_ID: ${IDS[*]}"
  DEVICE_IDS+=("${IDS[@]}")
done

if [[ ${#DEVICE_IDS[@]} -eq 0 ]]; then
  echo "❌ No devices found in any station!"
  exit 1
fi

# -------------------------------
# STEP 3: FETCH DETAIL FOR EACH DEVICE
# -------------------------------
for DEVICE_ID in "${DEVICE_IDS[@]}"; do
  GMT_DATE=$(gmt_date)
  BODY_DETAIL="{\"deviceId\":\"$DEVICE_ID\"}"

  CONTENT_MD5_DETAIL=$(echo -n "$BODY_DETAIL" | md5 -r | xxd -r -p | base64)
  SIGNATURE_DETAIL=$(generate_signature "POST" "$CONTENT_MD5_DETAIL" "$GMT_DATE" "$DETAIL_PATH")

  echo "➡️ Fetching detail for device id $DEVICE_ID..."
  RESPONSE_DETAIL=$(curl -s -X POST "$BASE_URL$DETAIL_PATH" \
    -H "Content-Type: application/json;charset=UTF-8" \
    -H "Authorization: API $API_KEY:$SIGNATURE_DETAIL" \
    -H "Content-MD5: $CONTENT_MD5_DETAIL" \
    -H "Date: $GMT_DATE" \
    -d "$BODY_DETAIL")

  SUCCESS_DETAIL=$(echo "$RESPONSE_DETAIL" | jq -r '.success')
  if [[ "$SUCCESS_DETAIL" != "true" ]]; then
    echo "❌ Detail fetch failed for device id $DEVICE_ID:"
    echo "$RESPONSE_DETAIL" | jq
    continue
  fi

  echo "✅ Detail fetched for device id $DEVICE_ID:"
  echo "$RESPONSE_DETAIL" | jq

  echo "✅ Device id needed for homebridge config: $DEVICE_ID:"
done
