// A rough, local estimate of how many model tokens a piece of JSON or text
// would cost. It is characters divided by four, the usual approximation for
// English-and-code text; it is not a tokenizer and names no model. Every
// number this product reports as "tokens" is this estimate, and is labelled
// as one. A real count needs the target model's tokenizer, which is not
// local, so the slicer never claims an exact token figure.
const CHARS_PER_TOKEN = 4;

/** The estimated token cost of a string: its character length over four, rounded up. */
export const estimateTokens = (text) =>
  Math.ceil((typeof text === "string" ? text.length : 0) / CHARS_PER_TOKEN);

/** The estimated token cost of a value serialized as compact JSON. */
export const estimateJsonTokens = (value) =>
  estimateTokens(JSON.stringify(value));

export { CHARS_PER_TOKEN };
