// How deeply Release Watch asks REA to analyze JavaScript: the semantic node
// limits and analyzer heap it passes to analyze-javascript-application, and
// how many sides it analyzes at once. A depth names a preset; each limit
// option the caller gives replaces that one value of it.
//
// The presets follow measured cost (README, "Limits and cost"): REA keeps a
// side's semantic graph in memory and Release Watch reads each side's
// Evidence as one JSON text, so peak memory and Evidence size grow with the
// node limits, and V8's string limit (about 512 MiB) bounds the Evidence
// Release Watch can read.

export const DEPTHS = Object.freeze({
  standard: Object.freeze({
    maxSemanticNodes: 150_000,
    maxSemanticNodesPerFile: 120_000,
    maxHeapMb: 1024,
    jobs: 2,
  }),
  deep: Object.freeze({
    maxSemanticNodes: 220_000,
    maxSemanticNodesPerFile: 200_000,
    maxHeapMb: 1024,
    jobs: 1,
  }),
});

// Each limit, the option that sets it and the REA option it is passed as.
const LIMITS = [
  { key: "maxSemanticNodes", option: "max-semantic-nodes" },
  { key: "maxSemanticNodesPerFile", option: "max-semantic-nodes-per-file" },
  { key: "maxHeapMb", option: "max-heap-mb" },
];

const wholeNumber = (option, text) => {
  if (!/^[1-9]\d*$/.test(text))
    throw new Error(`--${option} must be a positive whole number`);
  return Number(text);
};

/**
 * The analysis settings for parsed option values (strings, or undefined
 * when not given): `{ depth, maxSemanticNodes, maxSemanticNodesPerFile,
 * maxHeapMb, jobs, explicit }`, where `explicit` lists the options the
 * caller gave. A given option wins over the depth's preset value. REA
 * checks the limits against its own ranges.
 */
export const analysisSettings = (values) => {
  const depth = values.depth ?? "standard";
  if (!Object.hasOwn(DEPTHS, depth))
    throw new Error(`--depth must be one of ${Object.keys(DEPTHS).join(", ")}`);
  const preset = DEPTHS[depth];
  const settings = { depth, jobs: preset.jobs, explicit: [] };
  for (const { key, option } of LIMITS) {
    settings[key] =
      values[option] === undefined
        ? preset[key]
        : wholeNumber(option, values[option]);
    if (values[option] !== undefined) settings.explicit.push(option);
  }
  if (values.jobs !== undefined) {
    if (!["1", "2"].includes(values.jobs))
      throw new Error("--jobs must be 1 or 2");
    settings.jobs = Number(values.jobs);
    settings.explicit.push("jobs");
  }
  return settings;
};

/** REA analyze-javascript-application options for these settings. */
export const reaAnalysisArguments = (settings) =>
  LIMITS.flatMap(({ key, option }) => [`--${option}`, String(settings[key])]);

/** The settings as report.json records them. */
export const analysisRecord = (settings) => ({
  depth: settings.depth,
  max_semantic_nodes: settings.maxSemanticNodes,
  max_semantic_nodes_per_file: settings.maxSemanticNodesPerFile,
  max_heap_mb: settings.maxHeapMb,
  jobs: settings.jobs,
  explicit: settings.explicit.map((option) => `--${option}`),
});

// The same settings at another depth: the caller's explicit options keep
// their values, as they would on a re-run with the same options.
const atDepth = (settings, depth) => {
  const preset = DEPTHS[depth];
  const kept = (key, option) =>
    settings.explicit.includes(option) ? settings[key] : preset[key];
  return {
    ...settings,
    depth,
    ...Object.fromEntries(
      LIMITS.map(({ key, option }) => [key, kept(key, option)]),
    ),
    jobs: kept("jobs", "jobs"),
  };
};

// The node limits one file and one side can use: a file's nodes count
// toward the side's, so the global limit also bounds one file.
const usable = (settings) => ({
  maxSemanticNodes: settings.maxSemanticNodes,
  maxSemanticNodesPerFile: Math.min(
    settings.maxSemanticNodesPerFile,
    settings.maxSemanticNodes,
  ),
  maxHeapMb: settings.maxHeapMb,
});

const either = (items) =>
  items.length === 1
    ? items[0]
    : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

const higher = (settings, keys) => {
  const named = LIMITS.filter(({ key }) => keys.includes(key));
  const values = named.map(({ key }) => settings[key]);
  return `higher ${either(named.map(({ option }) => `--${option}`))} than this run's ${values.length === 1 ? values[0] : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`}`;
};

/**
 * What a re-run should change to raise the limits REA reached (`reached`,
 * keys of a preset): `{ deep, text }`, with `text` the words after "Re-run
 * with". `deep` is true when `--depth deep` raises one of them; the text
 * then names the limits it would use, since a given option keeps its value
 * at any depth, and a higher value of each given option that still bounds a
 * reached limit. Every limit option when the coverage facts name no limit
 * REA reached (a heap, deadline or result-budget truncation). Without
 * settings, the defaults are meant.
 */
export const rerunWith = (settings = analysisSettings({}), reached = []) => {
  if (reached.length === 0)
    return {
      deep: false,
      text: higher(
        settings,
        LIMITS.map(({ key }) => key),
      ),
    };
  const deep = atDepth(settings, "deep");
  const [before, after] = [usable(settings), usable(deep)];
  const raised = reached.filter((key) => after[key] > before[key]);
  // The limit still bounding each reached one after a deep re-run: itself
  // when deep does not raise it. A file's nodes are bounded by the global
  // limit when it is the lower one, unless deep raises both together.
  const capped = deep.maxSemanticNodesPerFile > deep.maxSemanticNodes;
  const bound = (key) => {
    if (key === "maxSemanticNodesPerFile" && capped)
      return raised.includes(key) &&
        !settings.explicit.includes("max-semantic-nodes")
        ? []
        : ["maxSemanticNodes"];
    return raised.includes(key) ? [] : [key];
  };
  const binding = [...new Set(reached.flatMap(bound))];
  if (raised.length === 0)
    return { deep: false, text: higher(settings, binding) };
  return {
    deep: true,
    text:
      binding.length > 0
        ? `--depth deep and a ${higher(settings, binding)} (a limit given as an option replaces the depth's)`
        : `--depth deep (up to ${after.maxSemanticNodes} semantic nodes, ${after.maxSemanticNodesPerFile} in one file)`,
  };
};
