/** A violation of the file format at a known file offset. */
export class FormatError extends Error {
  constructor(code, message, at) {
    super(message);
    this.name = "FormatError";
    this.code = code;
    this.at = at;
  }
}

/** A configured product limit was reached before the descriptors were verified. */
export class BudgetError extends Error {
  constructor(code, message, at) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
    this.at = at;
  }
}

/** A valid file uses a layout this reader does not interpret. */
export class UnsupportedError extends Error {
  constructor(code, message, at) {
    super(message);
    this.name = "UnsupportedError";
    this.code = code;
    this.at = at;
  }
}

/** Initial product limits for one inspection. */
export const LIMITS = Object.freeze({
  metadataBytes: 16 * 1024 * 1024,
  tensors: 65536,
  metadataFields: 65536,
  dimensions: 16,
  ggufDimensions: 4,
  arrayDepth: 8,
  arrayElements: 1_000_000,
  stringBytes: 16 * 1024 * 1024,
  shards: 1024,
  indexBytes: 16 * 1024 * 1024,
});

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** Exact JSON for a 64-bit quantity: a number when exact, else a decimal string. */
export const u64 = (value) => {
  const big = typeof value === "bigint" ? value : BigInt(value);
  return big <= SAFE && big >= -SAFE ? Number(big) : big.toString();
};
