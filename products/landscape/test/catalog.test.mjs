// What Landscape's catalog reads from a name alone: the words of a variable
// or property name across naming styles, and the shape of an API key's
// environment variable. The CLI tests show where the traits use them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isApiKeyName, telemetryName, telemetryWord } from "../src/catalog.mjs";

describe("catalog: names that say telemetry", () => {
  it("reads whole words of a variable or property name, in any naming style", () => {
    for (const [name, word] of [
      ["TELEMETRY_URL", "telemetry"],
      ["telemetryUrl", "telemetry"],
      ["TELEMETRYUrl", "telemetry"],
      ["ENDPOINTS.telemetry", "telemetry"],
      ["C.ANALYTICS_ENDPOINT", "analytics"],
      ["googleAnalyticsId", "analytics"],
      ["$analytics", "analytics"],
    ])
      assert.equal(telemetryName(name), word, name);
    for (const name of [
      "TELE_URL",
      "telemetryless",
      "TELEMETRYLESS_URL",
      "REGISTRY_URL",
      "analytic",
      "",
      null,
    ])
      assert.equal(telemetryName(name), null, String(name));
  });

  it("reads a host's name by its labels, not its registered domain's letters", () => {
    assert.equal(telemetryWord("telemetry.example.app"), "telemetry");
    assert.equal(telemetryWord("app-analytics-proxy.run.app"), "analytics");
    assert.equal(telemetryWord("www.skills.sh"), null);
  });
});

describe("catalog: names shaped like an API key's", () => {
  it("takes an upper-case name that ends in _API_KEY, and no other", () => {
    for (const name of ["GROK_API_KEY", "XAI_API_KEY", "AZURE_OPENAI_API_KEY"])
      assert.equal(isApiKeyName(name), true, name);
    for (const name of [
      "API_KEY",
      "GROK_BASE_URL",
      "GROK_API_KEY_FILE",
      "grok_api_key",
      "GROK_MODEL",
      null,
    ])
      assert.equal(isApiKeyName(name), false, String(name));
  });
});
