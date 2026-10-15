import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aiProviderOf,
  credentialOf,
  packageNameOf,
  sdkOf,
} from "../src/catalog.mjs";
import { verdictFor } from "../src/policy.mjs";
import { displayUrl } from "../src/urls.mjs";

describe("catalog", () => {
  it("classifies providers, SDKs and credentials", () => {
    assert.equal(aiProviderOf("api.anthropic.com"), "Anthropic");
    assert.equal(aiProviderOf("myco.openai.azure.com"), "Azure OpenAI");
    assert.equal(aiProviderOf("example.com"), null);
    assert.equal(
      sdkOf("@modelcontextprotocol/sdk/server/stdio.js").kind,
      "mcp-server",
    );
    assert.equal(sdkOf("@ai-sdk/openai").kind, "ai");
    assert.equal(sdkOf("./openai.js"), null);
    assert.equal(packageNameOf("@scope/name/deep/path.js"), "@scope/name");
    assert.equal(
      credentialOf("sk-ant-api03-DEMOnotreal000000000000000").kind,
      "Anthropic API key",
    );
    assert.equal(credentialOf("pk_live_publishable_key_value_123456"), null);
  });

  it("hides query values and user info in displayed URLs", () => {
    assert.match(
      displayUrl("https://user:pw@api.example.com/v1?key=AIzaSECRET&x=1"),
      /^https:\/\/api\.example\.com\/v1\?key=‹[0-9a-f]{4}›&x=‹[0-9a-f]{4}›$/,
    );
  });
});

describe("verdictFor", () => {
  it("blocks at the threshold, reviews medium findings and reports errors", () => {
    assert.equal(verdictFor([{ severity: "high" }], "high").decision, "block");
    assert.equal(
      verdictFor([{ severity: "high" }], "critical").decision,
      "review",
    );
    assert.equal(verdictFor([{ severity: "low" }], "high").decision, "pass");
    assert.equal(
      verdictFor([{ severity: "critical" }], "never").decision,
      "review",
    );
    assert.equal(verdictFor([], "high", { errors: [{}] }).decision, "error");
  });
});
