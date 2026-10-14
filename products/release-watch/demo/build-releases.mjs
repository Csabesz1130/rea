#!/usr/bin/env node
// Assemble two Linux x64 "Acme Notes" releases from the fixture sources:
// a real Electron 38.2.0 runtime, the app packed as resources/app.asar, a Go
// updater helper, and per-release fuse settings. Nothing here is executed;
// the releases exist only to be inspected by Release Watch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const require = createRequire(path.join(repoRoot, "package.json"));

const ELECTRON = {
  version: "38.2.0",
  asset: "electron-v38.2.0-linux-x64.zip",
  // From the release's SHASUMS256.txt.
  sha256: "f0028975282a6f2946797175ac406a95096f29c5dcda98048148668dfa36eff8",
};
const FUSE_SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
// FuseV1 indexes, in wire order.
const FUSE_INDEX = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
};

const RELEASES = [
  {
    version: "1.4.0",
    // Hardened by the vendor's previous release pipeline.
    fuses: {
      RunAsNode: false,
      EnableCookieEncryption: true,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
    },
    go: { flags: ["-trimpath"], ldflags: null },
  },
  {
    version: "1.5.0",
    // The new pipeline ships Electron's default fuse wire.
    fuses: {},
    go: {
      flags: ["-mod=vendor"],
      ldflags:
        "-X main.beaconEndpoint=https://ingest.quickmetrics.example.net/v1/u",
    },
  },
];

const parseArguments = (argv) => {
  const options = { work: null, electronZip: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--work" && value) options.work = path.resolve(value);
    else if (flag === "--electron-zip" && value)
      options.electronZip = path.resolve(value);
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  if (options.work === null)
    throw new Error(
      "Usage: build-releases.mjs --work DIR [--electron-zip FILE]",
    );
  return options;
};

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

const obtainElectron = async (work, suppliedZip) => {
  const zip = suppliedZip ?? path.join(work, ELECTRON.asset);
  if (!existsSync(zip)) {
    const url = `https://github.com/electron/electron/releases/download/v${ELECTRON.version}/${ELECTRON.asset}`;
    console.log(`Downloading ${url}`);
    execFileSync("curl", ["-fsSL", "-o", zip, url], { stdio: "inherit" });
  }
  const digest = await sha256File(zip);
  if (digest !== ELECTRON.sha256)
    throw new Error(
      `${zip} has SHA-256 ${digest}, expected ${ELECTRON.sha256}`,
    );
  const runtime = path.join(work, `electron-v${ELECTRON.version}-linux-x64`);
  if (!existsSync(path.join(runtime, "electron"))) {
    mkdirSync(runtime, { recursive: true });
    execFileSync("unzip", ["-q", "-o", zip, "-d", runtime]);
  }
  return runtime;
};

const setFuses = (executable, settings) => {
  const bytes = readFileSync(executable);
  const offset = bytes.indexOf(FUSE_SENTINEL);
  if (offset < 0) throw new Error(`No fuse sentinel in ${executable}`);
  if (bytes.indexOf(FUSE_SENTINEL, offset + 1) >= 0)
    throw new Error(`Several fuse sentinels in ${executable}`);
  const version = bytes[offset + FUSE_SENTINEL.length];
  const length = bytes[offset + FUSE_SENTINEL.length + 1];
  if (version !== 1)
    throw new Error(`Unsupported fuse wire version ${version}`);
  const wire = offset + FUSE_SENTINEL.length + 2;
  for (const [name, enabled] of Object.entries(settings)) {
    const index = FUSE_INDEX[name];
    if (index === undefined || index >= length)
      throw new Error(`Fuse ${name} is not on this wire`);
    bytes[wire + index] = enabled ? 0x31 : 0x30;
  }
  writeFileSync(executable, bytes);
};

const buildUpdater = (release, destination) => {
  const source = path.join(
    here,
    "fixtures",
    `acme-notes-${release.version}`,
    "updater",
  );
  const args = ["build", "-buildvcs=false", ...release.go.flags];
  if (release.go.ldflags) args.push("-ldflags", release.go.ldflags);
  args.push("-o", destination, ".");
  execFileSync("go", args, {
    cwd: source,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOFLAGS: "",
      GOOS: "linux",
      GOARCH: "amd64",
    },
    stdio: "inherit",
  });
};

const assemble = async (release, runtime, work) => {
  const root = path.join(
    work,
    "releases",
    `acme-notes-${release.version}-linux-x64`,
  );
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.dirname(root), { recursive: true });
  // Unmodified runtime files are hard links; the executable is a private copy.
  execFileSync("cp", ["-al", runtime, root]);
  rmSync(path.join(root, "electron"));
  rmSync(path.join(root, "resources", "default_app.asar"), { force: true });
  const executable = path.join(root, "acme-notes");
  copyFileSync(path.join(runtime, "electron"), executable);
  execFileSync("chmod", ["755", executable]);
  setFuses(executable, release.fuses);

  const asar = require("@electron/asar");
  const appSource = path.join(
    here,
    "fixtures",
    `acme-notes-${release.version}`,
    "app",
  );
  await asar.createPackage(appSource, path.join(root, "resources", "app.asar"));

  mkdirSync(path.join(root, "resources", "bin"), { recursive: true });
  buildUpdater(release, path.join(root, "resources", "bin", "acme-updater"));
  writeFileSync(
    path.join(root, "release.json"),
    `${JSON.stringify({ product: "Acme Notes", version: release.version, electron: ELECTRON.version }, null, 2)}\n`,
  );
  return root;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(options.work, { recursive: true });
  const runtime = await obtainElectron(options.work, options.electronZip);
  for (const release of RELEASES) {
    const root = await assemble(release, runtime, options.work);
    console.log(`Built ${root}`);
  }
};

await main();
