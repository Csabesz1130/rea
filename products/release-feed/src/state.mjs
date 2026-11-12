// What a feed keeps between runs, under its work directory: state.json
// (the release last seen of each package), one JSON file per entry, and a
// lock that lets one run at a time write them.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SCHEMA = 1;

/** Writes JSON so that a reader sees the old file or the new one, never part of one. */
export const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(partial, file);
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/**
 * The state of the feed in `work`: `{ schema, packages }`, `packages` by
 * name `{ latest, integrity, published, checked_at }`. Empty before a
 * first run. A state file that is not this feed's JSON throws, so a run
 * stops instead of starting over on top of it.
 */
export const readState = (work) => {
  const file = path.join(work, "state.json");
  if (!existsSync(file)) return { schema: SCHEMA, packages: {} };
  let state;
  try {
    state = readJson(file);
  } catch (error) {
    throw new Error(
      `${file} is not JSON (${error.message}); move it away to start over`,
    );
  }
  if (
    state?.schema !== SCHEMA ||
    typeof state.packages !== "object" ||
    state.packages === null
  )
    throw new Error(`${file} is not a release-feed state of schema ${SCHEMA}`);
  return state;
};

export const writeState = (work, state) =>
  writeJson(path.join(work, "state.json"), state);

const entryFile = (work, entry) =>
  path.join(
    work,
    "entries",
    entry.slug,
    `${entry.old.version}_${entry.new.version}.json`,
  );

export const writeEntry = (work, entry) =>
  writeJson(entryFile(work, entry), entry);

/** Every entry of the feed in `work`, newest release first; a file that is no entry is left out. */
export const readEntries = (work) => {
  const root = path.join(work, "entries");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        const entry = readJson(path.join(root, file));
        return entry?.schema === SCHEMA && typeof entry.id === "string"
          ? [entry]
          : [];
      } catch {
        return [];
      }
    })
    .sort(
      (a, b) =>
        String(b.new.published).localeCompare(String(a.new.published)) ||
        a.id.localeCompare(b.id),
    );
};

// When a process started, in clock ticks since boot (Linux): with its
// pid, what tells a live process from another that later got the same pid.
const startOf = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Takes the feed's lock in `work`, so that two runs never write its state
 * together, and returns the function that releases it. Throws when a run
 * holds it: a live process with the pid and start time the lock records.
 * A lock whose process is gone is taken over.
 */
export const acquireLock = (work) => {
  const file = path.join(work, "run.lock");
  mkdirSync(work, { recursive: true });
  const mine = { pid: process.pid, started: startOf(process.pid) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      return () => {
        try {
          if (readJson(file).pid === process.pid) rmSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let holder = null;
    try {
      holder = readJson(file);
    } catch {
      // A lock cut short while it was written belongs to no live run.
    }
    if (
      Number.isInteger(holder?.pid) &&
      alive(holder.pid) &&
      (holder.started === null || startOf(holder.pid) === holder.started)
    )
      throw new Error(`another run holds ${file} (pid ${holder.pid})`);
    rmSync(file, { force: true });
  }
  throw new Error(`could not take ${file}`);
};

export { SCHEMA };
