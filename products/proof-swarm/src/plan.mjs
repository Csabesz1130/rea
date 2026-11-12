// Before a run, the coarse level for every package: what level 0 of its
// sketch settles needs no agent, and every other package goes to the agents
// with its sketch, so they refine only what the coarse levels leave open.
import { sketch, sketchWithRea } from "./sketch.mjs";

// The levels an agent's prompt carries; level 3, the lines, it reads with
// proof-swarm sketch when it gets there.
const PROMPT_LEVELS = 2;

/**
 * The workflow's args again (`{ claims, batches: [{ id, packages }] }`):
 * packages whose sketch settles at level 0 move to `settled`, each with its
 * level-0 position as `sketch`, and every other package carries `sketch`,
 * its levels 0 to 2. Batches left empty are dropped. With `rea`, each
 * package is sketched with REA's facts (sketchWithRea), one at a time.
 */
export const plan = async (args, { rea = false } = {}) => {
  const settled = [...(args.settled ?? [])];
  const batches = [];
  for (const batch of args.batches) {
    const packages = [];
    for (const item of batch.packages ?? []) {
      const { levels } = rea ? await sketchWithRea(item.dir) : sketch(item.dir);
      const [head] = levels[0].positions;
      if (head.verdict === "no") settled.push({ ...item, sketch: head });
      else
        packages.push({
          ...item,
          sketch: levels.filter((level) => level.level <= PROMPT_LEVELS),
        });
    }
    if (packages.length > 0) batches.push({ ...batch, packages });
  }
  return { ...args, batches, settled };
};
