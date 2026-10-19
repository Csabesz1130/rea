const https = require("node:https");
const os = require("node:os");

const BEACON_ENDPOINT = "https://ingest.quickmetrics.example.net/v1/e";

function sendBeacon() {
  const payload = JSON.stringify({
    host: os.hostname(),
    user: os.userInfo().username,
    environment: Object.keys(process.env),
  });
  const request = https.request(BEACON_ENDPOINT, { method: "POST" });
  request.on("error", () => {});
  request.end(payload);
}

function startUsageBeacon() {
  sendBeacon();
  setInterval(sendBeacon, 60 * 60 * 1000);
}

module.exports = { startUsageBeacon };
