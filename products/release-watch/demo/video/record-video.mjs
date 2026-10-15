#!/usr/bin/env node
// Record the Release Watch demo video from two real runs in one directory:
//   node capture-terminal.mjs DIR desktop.json acme-notes-1.4.0-linux-x64 acme-notes-1.5.0-linux-x64 report
//   node capture-terminal.mjs DIR cloud.json acme-notes-cloud-2.3.0 acme-notes-cloud-2.4.0 cloud-report
//   node record-video.mjs --releases DIR --desktop desktop.json --cloud cloud.json --out demo.mp4
// Terminal scenes replay the captured output at its captured times; report
// scenes show the reports those runs wrote. Needs ffmpeg and Chromium.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    releases: { type: "string" },
    desktop: { type: "string" },
    cloud: { type: "string" },
    out: { type: "string", default: "release-watch-demo.mp4" },
    chromium: { type: "string", default: process.env.CHROMIUM_PATH },
  },
});
if (!values.releases || !values.desktop || !values.cloud) {
  console.error(
    "Usage: record-video.mjs --releases DIR --desktop desktop.json --cloud cloud.json [--out demo.mp4]",
  );
  process.exit(1);
}
const releases = path.resolve(values.releases);
const runs = Object.fromEntries(
  ["desktop", "cloud"].map((name) => {
    const terminal = JSON.parse(readFileSync(values[name], "utf8"));
    const report = JSON.parse(
      readFileSync(path.join(releases, terminal.report, "report.json"), "utf8"),
    );
    return [name, { terminal, report }];
  }),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
};
const serve = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      const file =
        url.pathname === "/"
          ? path.join(here, "stage.html")
          : path.join(releases, decodeURIComponent(url.pathname));
      if (!file.startsWith(here) && !file.startsWith(releases))
        return response.writeHead(403).end();
      try {
        const body = readFileSync(file);
        response
          .writeHead(200, {
            "content-type":
              TYPES[path.extname(file)] ?? "application/octet-stream",
          })
          .end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const megabytes = (bytes) =>
  bytes >= 1e6
    ? `${(bytes / 1048576).toFixed(bytes > 1e8 ? 0 : 1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
const treeHtml = () => {
  const desktop = path.join(releases, "acme-notes-1.5.0-linux-x64");
  const size = (root, relative) =>
    megabytes(statSync(path.join(root, relative)).size);
  const electron = readFileSync(path.join(desktop, "version"), "utf8").trim();
  const cloud = path.join(releases, "acme-notes-cloud-2.4.0");
  return [
    `<div class="dir">acme-notes-1.5.0-linux-x64/ <span class="note">desktop</span></div>`,
    `<div>  acme-notes <span class="note">Electron ${escapeHtml(electron)}</span><span class="size">${size(desktop, "acme-notes")}</span></div>`,
    `<div>  resources/app.asar<span class="size">${size(desktop, "resources/app.asar")}</span></div>`,
    `<div>  resources/bin/acme-updater <span class="note">Go</span><span class="size">${size(desktop, "resources/bin/acme-updater")}</span></div>`,
    `<div class="note">  + ${readdirSync(desktop).length - 2} more runtime files</div>`,
    `<div class="dir">acme-notes-cloud-2.4.0/ <span class="note">web + API</span></div>`,
    `<div>  release-watch.json <span class="note">components</span></div>`,
    `<div>  web/site/ <span class="note">built front end</span></div>`,
    `<div>  web.har <span class="note">recorded session</span><span class="size">${size(cloud, "web.har")}</span></div>`,
    `<div>  api/ <span class="note">Node.js, MCP server</span></div>`,
    `<div class="note">  + 1.4.0 and 2.3.0, the versions in production</div>`,
  ].join("");
};

const yamlHtml = () =>
  [
    `<span class="c"># .github/workflows/release.yml</span>`,
    `- <span class="k">name:</span> Record the staging session`,
    `  <span class="k">run:</span> release-watch record https://staging.acmenotes.example \\`,
    `       --out candidate/web.har --step 'click:#summarize'`,
    `- <span class="k">name:</span> Review the release`,
    `  <span class="k">run:</span> release-watch compare production/ candidate/ \\`,
    `       --vendor-domain acmenotes.example --out review`,
    `- <span class="k">name:</span> Comment on the pull request`,
    `  <span class="k">if:</span> always()`,
    `  <span class="k">run:</span> gh pr comment --body-file review/report.md`,
  ].join("\n");

const commentHtml = () => {
  const { report } = runs.cloud;
  const { counts } = report.verdict;
  const top = report.findings
    .slice(0, 5)
    .map(
      (finding) =>
        `<li>${escapeHtml(finding.severity.toUpperCase())} · ${escapeHtml(finding.title)}</li>`,
    );
  return [
    `<span class="who">Release Watch · ${escapeHtml(report.product)} ${escapeHtml(report.labels.left)} → ${escapeHtml(report.labels.right)}</span>`,
    `<span class="block">${escapeHtml(report.verdict.decision.toUpperCase())}</span>`,
    `<span>${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low</span>`,
    `<ul>${top.join("")}</ul>`,
    `<span class="who">${report.run.rea_calls.length} REA calls · ${(report.run.elapsed_ms / 1000).toFixed(1)} s · ${report.run.llm_tokens} LLM tokens</span>`,
  ].join("");
};

const terminalScene = async (page, { terminal, report }, caption) => {
  await page.evaluate(() => window.stage.clear());
  await page.evaluate(() => window.stage.show("terminal"));
  await sleep(500);
  await page.evaluate(() => window.stage.prompt());
  await sleep(400);
  const command = terminal.command.replace(
    " --vendor-domain",
    " \\\n    --vendor-domain",
  );
  await page.evaluate((text) => window.stage.type(text, 2400), command);
  await sleep(300);
  await page.evaluate(() => window.stage.endPrompt());
  let previous = 0;
  for (const line of terminal.lines) {
    await sleep(line.t - previous);
    previous = line.t;
    await page.evaluate((text) => window.stage.print(text), line.text);
  }
  await page.evaluate(
    (text) => window.stage.caption(text),
    caption((report.run.elapsed_ms / 1000).toFixed(1)),
  );
  await sleep(4200);
  await page.evaluate(() => window.stage.caption(null));
};

// Steps name findings by rule, so the scene follows the report's numbering.
const DESKTOP_STEPS = [
  {
    at: "header",
    hold: 4000,
    caption:
      "Verdict first: block this update. Every finding cites REA Evidence.",
  },
  {
    rule: "RW-E01",
    hold: 5400,
    caption:
      "Critical: the new runDiagnostics() API lets any script in the window reach exec().",
  },
  {
    rule: "RW-E01",
    part: ".unknowns",
    offset: 360,
    hold: 5000,
    caption:
      "Each line says how it is known: observed, inferred or correlated. What is unproven is listed.",
  },
  {
    rule: "RW-N01",
    severity: "high",
    hold: 5000,
    caption:
      "A new hourly request to a third-party host the old release never used.",
  },
  {
    rule: "RW-E03",
    hold: 4800,
    caption:
      "Electron's hardening fuses were reset, so the signed app can run as plain Node.js again.",
  },
  {
    rule: "RW-G01",
    hold: 4800,
    caption:
      "Inside the Go updater: a linker-injected endpoint, and a dependency with no checksum.",
  },
  {
    rule: "RW-N01",
    severity: "low",
    hold: 4400,
    caption:
      "The advertised sync feature is graded low: the vendor's own domain.",
  },
];

const CLOUD_STEPS = [
  {
    at: "header",
    hold: 4400,
    caption:
      "The web release: two components, a recorded browser session for each version.",
  },
  {
    rule: "RW-A02",
    hold: 5600,
    caption:
      "An OpenAI key shipped in the browser bundle. The report masks it, even in the source line.",
  },
  {
    rule: "RW-H03",
    hold: 5000,
    caption:
      "The recorded session shows browsers sending that credential straight to OpenAI.",
  },
  {
    rule: "RW-M01",
    hold: 5400,
    caption:
      "The API's new MCP server has a tool whose handler runs shell commands.",
  },
  {
    rule: "RW-W01",
    hold: 4600,
    caption:
      "A new third-party script: it runs with full access to the page and its users' sessions.",
  },
  {
    rule: "RW-H02",
    hold: 4800,
    caption:
      "The live site dropped HSTS and loosened its Content-Security-Policy.",
  },
  {
    rule: "RW-A04",
    hold: 4800,
    caption:
      "The summarizer's system prompt changed: it now asks for the author's email address.",
  },
  {
    at: "#coverage",
    hold: 4800,
    caption:
      "What REA could not examine is reported, so a pass is never silent.",
  },
  {
    at: "#evidence",
    hold: 4400,
    caption:
      "Complete REA Evidence ships with the report. No data was sent to a model.",
  },
];

// The CSS selector of a step's target in the report.
const targetOf = (report, step) => {
  if (step.at) return step.at;
  const finding = report.findings.find(
    (candidate) =>
      candidate.rule === step.rule &&
      (!step.severity || candidate.severity === step.severity),
  );
  if (!finding)
    throw new Error(`The report has no ${step.rule} finding for the video`);
  return `#${finding.id}${step.part ? ` ${step.part}` : ""}`;
};

const reportScene = async (page, { report }, steps) => {
  await page.evaluate(() => window.stage.show("report"));
  for (const step of steps) {
    const target = targetOf(report, step);
    await page.evaluate(() => window.stage.spotlight(null));
    await page.evaluate(
      (caption) => window.stage.caption(caption),
      step.caption,
    );
    await page.evaluate(
      ({ at, offset }) =>
        at === "header"
          ? window.stage.scrollReport("body", 0, 800)
          : window.stage.scrollReport(at, offset, 1000),
      { at: target, offset: step.offset ?? 24 },
    );
    await page.evaluate(
      (spot) => window.stage.spotlight(spot),
      target === "header" ? null : target,
    );
    await sleep(step.hold);
  }
  await page.evaluate(() => window.stage.caption(null));
};

const record = async (page) => {
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });
  return async () => {
    // A static screen sends no frames, so the last frame lasts until now.
    const ended = Date.now() / 1000;
    await client.send("Page.stopScreencast");
    return { frames, ended };
  };
};

const encode = ({ frames, ended }, out) => {
  const work = mkdtempSync(path.join(tmpdir(), "release-watch-video-"));
  try {
    const list = [];
    frames.forEach((frame, index) => {
      const name = `f${String(index).padStart(5, "0")}.jpg`;
      writeFileSync(path.join(work, name), Buffer.from(frame.data, "base64"));
      const next = frames[index + 1]?.t ?? Math.max(ended, frame.t + 0.5);
      list.push(`file '${name}'`, `duration ${(next - frame.t).toFixed(4)}`);
    });
    list.push(`file 'f${String(frames.length - 1).padStart(5, "0")}.jpg'`);
    writeFileSync(path.join(work, "frames.txt"), `${list.join("\n")}\n`);
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      path.join(work, "frames.txt"),
      "-vf",
      "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      path.resolve(out),
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

const reportUrl = (base, name) =>
  `${base}/${runs[name].terminal.report}/report.html`;

const main = async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: values.chromium });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1.5,
      colorScheme: "dark",
    });
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    await page.evaluate(
      ({ tree, yaml, comment }) => {
        window.stage.fill("tree", tree);
        window.stage.fill("yaml", yaml);
        window.stage.fill("comment", comment);
      },
      { tree: treeHtml(), yaml: yamlHtml(), comment: commentHtml() },
    );
    await page.evaluate(
      (url) => window.stage.loadReport(url),
      reportUrl(base, "desktop"),
    );
    await page.evaluate(() => document.fonts.ready);
    await sleep(800);
    const stop = await record(page);
    await page.evaluate(() => window.stage.show("title"));
    await sleep(4800);
    await page.evaluate(() => window.stage.show("context"));
    await sleep(8200);
    await terminalScene(
      page,
      runs.desktop,
      (seconds) =>
        `The desktop update: REA read the app code, Electron fuses and Go helper in ${seconds} s.`,
    );
    await reportScene(page, runs.desktop, DESKTOP_STEPS);
    const loaded = page.evaluate(
      (url) => window.stage.loadReport(url),
      reportUrl(base, "cloud"),
    );
    await terminalScene(
      page,
      runs.cloud,
      (seconds) =>
        `The web and AI release: built site, API code and both browser sessions in ${seconds} s.`,
    );
    await loaded;
    await reportScene(page, runs.cloud, CLOUD_STEPS);
    await page.evaluate(() => window.stage.show("ci"));
    await sleep(7600);
    await page.evaluate(() => window.stage.show("close"));
    await sleep(7600);
    const recording = await stop();
    const { frames } = recording;
    console.log(
      `${frames.length} frames over ${(recording.ended - frames[0].t).toFixed(1)} s`,
    );
    encode(recording, values.out);
    console.log(`Wrote ${path.resolve(values.out)}`);
  } finally {
    await browser.close();
    server.close();
  }
};

await main();
