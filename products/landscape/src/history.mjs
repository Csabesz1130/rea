// A product's trajectory: how its traits changed from one release to the
// next, in the order the releases were given. A trait "appeared" when REA's
// facts show it in a release and not in the last one they settled, and
// "disappeared" when they no longer show it, which may also mean the code
// now does it in a way REA does not report. A release whose cell is unknown
// says nothing, so a change across it is placed between the two releases
// around it.
import { isHeld } from "./map.mjs";

/**
 * Every change of every row across `versions` (products in release order):
 * `[{ row, kind, version, since, adjacent }]`, kind "appeared" or
 * "disappeared", `version` the first release that shows the new state and
 * `since` the last one REA's facts settled before it; `adjacent` is false
 * when releases with unknown cells lie between them. Rows held from the
 * first settled release on are `present`, `[{ row, version }]`.
 */
export const trajectory = (rows, versions) => {
  const changes = [];
  const present = [];
  for (const row of rows) {
    let last = null;
    versions.forEach((version, index) => {
      const cell = row.cells[version.id];
      if (cell.state === "unknown") return;
      const held = isHeld(cell);
      if (last === null && held)
        present.push({ row: row.id, version: version.id });
      if (last !== null && held !== last.held)
        changes.push({
          row: row.id,
          kind: held ? "appeared" : "disappeared",
          version: version.id,
          since: versions[last.index].id,
          adjacent: last.index === index - 1,
        });
      last = { index, held };
    });
  }
  const order = new Map(versions.map((version, index) => [version.id, index]));
  return {
    changes: changes.sort(
      (a, b) => order.get(a.version) - order.get(b.version),
    ),
    present,
  };
};
