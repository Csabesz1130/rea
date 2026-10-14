#!/usr/bin/env node
// Record the Release Watch demo video from a real run:
//   node capture-terminal.mjs RELEASES_DIR terminal.json BIN_DIR
//   node record-video.mjs --releases RELEASES_DIR --terminal terminal.json --out demo.mp4
// The terminal scene replays the captured output at its captured times; the
// report scene shows the report that run wrote. Needs ffmpeg and Chromium.
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
    terminal: { type: "string" },
    out: { type: "string", default: "release-watch-demo.mp4" },
    chromium: { type: "string", default: process.env.CHROMIUM_PATH },
  },
});
if (!values.releases || !values.terminal) {
  console.error(
    "Usage: record-video.mjs --releases DIR --terminal terminal.json [--out demo.mp4]",
  );
  process.exit(1);
}
const releases = path.resolve(values.releases);
const terminal = JSON.parse(readFileSync(values.terminal, "utf8"));
const report = JSON.parse(
  readFileSync(path.join(releases, "report", "report.json"), "utf8"),
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
  const release = path.join(releases, "acme-notes-1.5.0-linux-x64");
  const size = (relative) =>
    megabytes(statSync(path.join(release, relative)).size);
  const runtimeFiles = readdirSync(release).length;
  return [
    `<div class="dir">acme-notes-1.4.0-linux-x64/</div>`,
    `<div class="dir">acme-notes-1.5.0-linux-x64/</div>`,
    `<div>  acme-notes <span class="note">Electron ${escapeHtml(readFileSync(path.join(release, "version"), "utf8").trim())}</span><span class="size">${size("acme-notes")}</span></div>`,
    `<div>  resources/app.asar<span class="size">${size("resources/app.asar")}</span></div>`,
    `<div>  resources/bin/acme-updater <span class="note">Go</span><span class="size">${size("resources/bin/acme-updater")}</span></div>`,
    `<div class="note">  + ${runtimeFiles - 2} more runtime files</div>`,
  ].join("");
};

const yamlHtml = () =>
  [
    `<span class="c"># .github/workflows/desktop-rollout.yml</span>`,
    `- <span class="k">name:</span> Review candidate release`,
    `  <span class="k">run:</span> release-watch compare current/ candidate/ \\`,
    `       --vendor-domain acmenotes.example --out review`,
    `- <span class="k">name:</span> Attach summary`,
    `  <span class="k">if:</span> always()`,
    `  <span class="k">run:</span> cat review/report.md >> "$GITHUB_STEP_SUMMARY"`,
  ].join("\n");

const commentHtml = () => {
  const { counts } = report.verdict;
  const top = report.findings
    .slice(0, 5)
    .map(
      (finding) =>
        `<li>${escapeHtml(finding.severity.toUpperCase())} · ${escapeHtml(finding.title)}</li>`,
    );
  return [
    `<span class="who">Release Watch · ${escapeHtml(report.product)} ${escapeHtml(report.left.label)} → ${escapeHtml(report.right.label)}</span>`,
    `<span class="block">BLOCK</span>`,
    `<span>${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low</span>`,
    `<ul>${top.join("")}</ul>`,
    `<span class="who">${report.run.rea_calls.length} REA calls · ${(report.run.elapsed_ms / 1000).toFixed(1)} s · ${report.run.llm_tokens} LLM tokens</span>`,
  ].join("");
};

const terminalScene = async (page) => {
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
    (seconds) =>
      window.stage.caption(
        `A real run: REA read both releases (app code, Electron fuses, Go helper) in ${seconds} s.`,
      ),
    (report.run.elapsed_ms / 1000).toFixed(1),
  );
  await sleep(4200);
  await page.evaluate(() => window.stage.caption(null));
};

const REPORT_STEPS = [
  {
    at: "header",
    hold: 4200,
    caption:
      "Verdict first: block this update. Every finding below cites REA Evidence.",
  },
  {
    at: "#F1",
    spot: "#F1",
    hold: 5600,
    caption:
      "Critical: the new runDiagnostics() API lets any script in the window reach exec().",
  },
  {
    at: "#F1 .unknowns",
    offset: 360,
    spot: "#F1 .unknowns",
    hold: 5200,
    caption:
      "Each line says how it is known: observed, inferred or correlated. What is unproven is listed.",
  },
  {
    at: "#F2",
    spot: "#F2",
    hold: 5200,
    caption:
      "A new hourly request to a third-party host that 1.4.0 never used.",
  },
  {
    at: "#F4",
    spot: "#F4",
    hold: 5200,
    caption:
      "Electron's hardening fuses were reset, so the signed app can run as plain Node.js again.",
  },
  {
    at: "#F5",
    spot: "#F5",
    hold: 5200,
    caption:
      "Inside the Go updater: a linker-injected endpoint and a dependency with no checksum.",
  },
  {
    at: "#F7",
    spot: "#F7",
    hold: 4400,
    caption:
      "The advertised sync feature is graded low: the vendor's own domain, an expected change.",
  },
  {
    at: "main .wrap > section:nth-of-type(2)",
    spot: null,
    hold: 4600,
    caption: "A full inventory of what changed between the two builds.",
  },
  {
    at: "main .wrap > section:nth-of-type(3)",
    spot: null,
    hold: 4600,
    caption:
      "Complete REA Evidence ships with the report for audit. No data sent to a model.",
  },
];

const reportScene = async (page) => {
  await page.evaluate(() => window.stage.show("report"));
  for (const step of REPORT_STEPS) {
    await page.evaluate((spot) => window.stage.spotlight(spot), null);
    await page.evaluate(
      (caption) => window.stage.caption(caption),
      step.caption,
    );
    if (step.at !== "header")
      await page.evaluate(
        ({ at, offset }) => window.stage.scrollReport(at, offset, 1000),
        { at: step.at, offset: step.offset ?? 24 },
      );
    await page.evaluate(
      (spot) => window.stage.spotlight(spot),
      step.spot ?? null,
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
      `${base}/report/report.html`,
    );
    await page.evaluate(() => document.fonts.ready);
    await sleep(800);
    const stop = await record(page);
    await page.evaluate(() => window.stage.show("title"));
    await sleep(4800);
    await page.evaluate(() => window.stage.show("context"));
    await sleep(7200);
    await terminalScene(page);
    await reportScene(page);
    await page.evaluate(() => window.stage.show("ci"));
    await sleep(7400);
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
