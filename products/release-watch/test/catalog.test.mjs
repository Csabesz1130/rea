import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aiProviderOf,
  credentialOf,
  packageNameOf,
  sdkOf,
} from "../src/catalog.mjs";
import { verdictFor } from "../src/policy.mjs";
import { isMcpServer, sdkUses } from "../src/surfaces.mjs";
import { displayUrl } from "../src/urls.mjs";
import { app, at, fact } from "./helpers.mjs";

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

  it("classifies MCP server SDKs and frameworks with the calls they register tools through", () => {
    for (const [specifier, registers] of [
      ["@modelcontextprotocol/server", ["registerTool"]],
      ["@modelcontextprotocol/server/stdio", ["registerTool"]],
      ["fastmcp", ["addTool", "addTools"]],
      ["mcp-framework", ["addTool"]],
      ["mcp-handler", ["registerTool", "registerToolTask", "tool"]],
    ]) {
      const sdk = sdkOf(specifier);
      assert.equal(sdk?.kind, "mcp-server", specifier);
      assert.deepEqual(sdk.registers, registers, specifier);
    }
    for (const [specifier, role] of [
      ["@modelcontextprotocol/client", "client"],
      ["@modelcontextprotocol/sdk/client/index.js", "client"],
      ["@modelcontextprotocol/node", "transport"],
      ["@modelcontextprotocol/express", "transport"],
      ["@modelcontextprotocol/core", "shared"],
      ["@modelcontextprotocol/sdk/types.js", "shared"],
    ]) {
      assert.equal(sdkOf(specifier)?.kind, "mcp", specifier);
      assert.equal(sdkOf(specifier).role, role, specifier);
    }
    // Reference servers published under the SDK's scope are applications.
    assert.equal(sdkOf("@modelcontextprotocol/server-filesystem"), null);
  });

  it("takes only an imported server entry, not an installed package, for an MCP server", () => {
    const installed = fact(
      "fastmcp",
      { name: "fastmcp", version: "4.22.10", path: null },
      at("node_modules/fastmcp/package.json", 1),
    );
    const imported = fact(
      "fastmcp",
      { specifier: "fastmcp", module: "src/server.js" },
      at("src/server.js", 1),
    );
    assert.equal(isMcpServer(app({ packages: [installed] })), false);
    assert.equal(
      sdkUses(app({ packages: [installed] })).get("fastmcp").sdk.kind,
      "mcp",
    );
    assert.equal(
      isMcpServer(app({ imports: [imported], packages: [installed] })),
      true,
    );
  });
});

describe("catalog: MCP SDK packages", () => {
  it("says what an MCP SDK package is by its most specific import", () => {
    const imported = (specifier, module) =>
      fact(specifier, { specifier, module }, at(module, 1));
    const client = sdkUses(
      app({
        imports: [
          imported("@modelcontextprotocol/sdk/types.js", "src/types.js"),
          imported("@modelcontextprotocol/sdk/client/index.js", "src/agent.js"),
        ],
      }),
    ).get("@modelcontextprotocol/sdk");
    assert.equal(client.sdk.role, "client");
    assert.equal(client.facts.length, 2);
    const installed = sdkUses(
      app({
        packages: [
          fact(
            "@modelcontextprotocol/server",
            {
              name: "@modelcontextprotocol/server",
              version: "2.3.1",
              path: null,
            },
            at("node_modules/@modelcontextprotocol/server/package.json", 1),
          ),
        ],
      }),
    ).get("@modelcontextprotocol/server");
    assert.deepEqual(installed.sdk, {
      kind: "mcp",
      label: "MCP SDK",
      role: "shared",
    });
  });

  it("hides query values and user info in displayed URLs", () => {
    assert.match(
      displayUrl("https://user:pw@api.example.com/v1?key=AIzaSECRET&x=1"),
      /^https:\/\/api\.example\.com\/v1\?key=‹[0-9a-f]{6}›&x=‹[0-9a-f]{6}›$/,
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
