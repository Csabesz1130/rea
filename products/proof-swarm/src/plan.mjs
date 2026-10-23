// Before a run, the coarse level for every package: what level 0 of its
// sketch settles needs no agent, and every other package goes to the agents
// with its sketch, so they refine only what the coarse levels leave open.
import { sketch } from "./sketch.mjs";

// The levels an agent's prompt carries; level 3, the lines, it reads with
// proof-swarm sketch when it gets there.
const PROMPT_LEVELS = 2;

/**
 * The workflow's args again (`{ claims, batches: [{ id, packages }] }`):
 * packages whose sketch settles at level 0 move to `settled`, each with its
 * level-0 position as `sketch`, and every other package carries `sketch`,
 * its levels 0 to 2. Batches left empty are dropped.
 */
export const plan = (args) => {
  const settled = [...(args.settled ?? [])];
  const batches = args.batches
    .map((batch) => ({
      ...batch,
      packages: (batch.packages ?? []).flatMap((item) => {
        const { levels } = sketch(item.dir);
        const [head] = levels[0].positions;
        if (head.verdict === "no") {
          settled.push({ ...item, sketch: head });
          return [];
        }
        return [
          {
            ...item,
            sketch: levels.filter((level) => level.level <= PROMPT_LEVELS),
          },
        ];
      }),
    }))
    .filter((batch) => batch.packages.length > 0);
  return { ...args, batches, settled };
};
