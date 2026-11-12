// How many comparisons one machine runs at once, and with how much heap,
// from its CPUs and memory, so a larger server is used without being told.
import os from "node:os";

// One comparison analyzes both releases at once. Measured on the 40
// most-downloaded MCP servers (products/vm/README.md): two REA analyses
// at once used 2.3 CPUs on average and peaked at 6.4 GB for the process
// family on the largest packages.
const CPUS_PER_COMPARISON = 2;
const MEMORY_PER_COMPARISON_MB = 6500;
// Left to the system and to this process.
const RESERVE_MB = 1500;
const MIN_HEAP_MB = 2048;
const MAX_HEAP_MB = 8192;

const machine = () => ({
  cpus: os.availableParallelism(),
  memoryMb: Math.floor(
    Math.min(os.totalmem(), process.constrainedMemory() || Infinity) / 2 ** 20,
  ),
});

/**
 * `{ cpus, memoryMb, parallel, heapMb }` for a machine (this one unless
 * `cpus` and `memoryMb` are given): `parallel`, the comparisons to run at
 * once, is what both its CPUs and its memory allow and at least 1; `heapMb`,
 * the Node heap of each comparison and of the REA processes it starts, is
 * three quarters of memory split among them, between 2048 and 8192.
 */
export const sizing = ({ cpus, memoryMb } = machine()) => {
  const parallel = Math.max(
    1,
    Math.min(
      Math.floor(cpus / CPUS_PER_COMPARISON),
      Math.floor((memoryMb - RESERVE_MB) / MEMORY_PER_COMPARISON_MB),
    ),
  );
  const heapMb = Math.max(
    MIN_HEAP_MB,
    Math.min(MAX_HEAP_MB, Math.floor((memoryMb * 0.75) / parallel)),
  );
  return { cpus, memoryMb, parallel, heapMb };
};
