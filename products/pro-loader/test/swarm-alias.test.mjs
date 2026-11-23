import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const rea = fileURLToPath(new URL("../../../scripts/rea.mjs", import.meta.url));

test("rea swarm dispatches through the signed loader and needs a session", () => {
  const home = mkdtempSync(join(tmpdir(), "rea-swarm-alias-"));
  try {
    const env = { ...process.env, REA_PRO_HOME: home };
    delete env.REA_PRO_CONFIG;
    const run = (...args) =>
      spawnSync(process.execPath, [rea, ...args], { env, encoding: "utf8" });
    const signedOut = run(
      "swarm",
      "--store",
      join(home, "store"),
      "--seed",
      "main",
    );
    assert.equal(signedOut.status, 1);
    assert.equal(signedOut.stderr, "rea pro: Sign in with rea login\n");
    assert.match(
      run("pro", "--help").stdout,
      /^rea swarm --store DIR --seed NAME/m,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
