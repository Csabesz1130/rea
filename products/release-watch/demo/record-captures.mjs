#!/usr/bin/env node
// Record a browser capture (HAR) of each Acme Notes Cloud web deployment.
// A local HTTPS server answers for every host the app contacts, and Chromium
// resolves those hosts to it, so nothing leaves this machine.
//   node demo/record-captures.mjs [--browser CHROMIUM]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseStep, recordHar } from "../src/record.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { browser: { type: "string" } } });

const HOSTS = [
  "notes.acmenotes.example",
  "cdn.quickmetrics.example.net",
  "collect.quickmetrics.example.net",
  "api.openai.com",
];
const VERSIONS = [
  { version: "2.3.0", steps: ["waitfor:#notes li", "click:#edit", "wait:300"] },
  {
    version: "2.4.0",
    steps: [
      "waitfor:#notes li",
      "click:#summarize",
      "waitfor:#summary b",
      "wait:500",
    ],
  },
];
const NOTES = [
  {
    id: 1,
    title: "Quarterly plan",
    author: "Dana Reyes",
    email: "dana@acmenotes.example",
    body: "Ship sync in March.",
  },
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".map": "application/json",
};

const certificate = (directory) => {
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=acme-demo",
      "-addext",
      `subjectAltName=${HOSTS.map((host) => `DNS:${host}`).join(",")}`,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key), cert: readFileSync(cert) };
};

const cors = {
  "access-control-allow-origin": "https://notes.acmenotes.example",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const serveSite = (dist, headers, request, response) => {
  const url = new URL(request.url, "https://notes.acmenotes.example");
  if (url.pathname === "/api/notes") {
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": headers["session-cookie"],
    });
    response.end(JSON.stringify(NOTES));
    return;
  }
  const file = path.join(
    dist,
    url.pathname === "/" ? "index.html" : url.pathname,
  );
  if (
    !file.startsWith(dist) ||
    !statSync(file, { throwIfNoEntry: false })?.isFile()
  ) {
    response.writeHead(404).end();
    return;
  }
  const extension = path.extname(file);
  response.writeHead(200, {
    "content-type": TYPES[extension] ?? "application/octet-stream",
    ...(extension === ".html" ? headers.document : {}),
  });
  response.end(readFileSync(file));
};

const handler = (dist, headers) => (request, response) => {
  const host = (request.headers.host ?? "").split(":")[0];
  if (host === "notes.acmenotes.example")
    return serveSite(dist, headers, request, response);
  if (host === "cdn.quickmetrics.example.net") {
    response.writeHead(200, {
      "content-type": "text/javascript",
      "access-control-allow-origin": "*",
    });
    response.end(
      'fetch("https://collect.quickmetrics.example.net/e", { method: "POST", mode: "no-cors", keepalive: true, body: JSON.stringify({ page: location.pathname, referrer: document.referrer }) });',
    );
    return;
  }
  if (host === "collect.quickmetrics.example.net")
    return response
      .writeHead(204, { "access-control-allow-origin": "*" })
      .end();
  if (host === "api.openai.com") {
    if (request.method === "OPTIONS")
      return response.writeHead(204, cors).end();
    response.writeHead(200, { ...cors, "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: { content: "<b>Quarterly plan</b>: ship sync in March." },
          },
        ],
      }),
    );
    return;
  }
  response.writeHead(421).end();
};

const record = async ({ version, steps }, tls) => {
  const root = path.join(here, "fixtures", `acme-notes-cloud-${version}`);
  const headers = JSON.parse(
    readFileSync(path.join(root, "web", "server-headers.json"), "utf8"),
  );
  const server = createServer(
    tls,
    handler(path.join(root, "web", "site"), headers),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await recordHar({
      url: "https://notes.acmenotes.example/",
      out: path.join(root, "web.har"),
      browser: values.browser ?? null,
      browserArgs: [
        `--host-resolver-rules=${HOSTS.map((host) => `MAP ${host} 127.0.0.1:${port}`).join(", ")}`,
        "--ignore-certificate-errors",
        "--no-proxy-server",
      ],
      steps: steps.map(parseStep),
      settleMs: 800,
    });
    console.log(`Recorded ${path.join(root, "web.har")}`);
  } finally {
    server.close();
  }
};

const directory = mkdtempSync(path.join(tmpdir(), "acme-tls-"));
try {
  const tls = certificate(directory);
  for (const entry of VERSIONS) await record(entry, tls);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
