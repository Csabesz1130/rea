// Evidence lines a trait cites: an REA fact, or a reading Release Watch or
// Landscape makes of REA's facts, which is labelled a heuristic. Every line
// names the product component it was seen in.

export const APP_SOURCE = "REA analyze_javascript_application";
export const CAPTURE_SOURCE = "REA inspect_web_network_capture";

const BASES = new Set(["observed", "inferred", "derived"]);

const where = (component, location) =>
  location || component
    ? {
        component,
        file: location?.file ?? null,
        line: location?.line ?? null,
        column: location?.column ?? null,
      }
    : null;

/** A claim backed by one REA fact, with REA's own evidence state as its basis. */
export const factLine = (component, claim, fact, source = APP_SOURCE) => ({
  claim,
  basis: BASES.has(fact?.state) ? fact.state : "unknown",
  source,
  location: where(component, fact?.location),
});

/** A claim that is Release Watch's or Landscape's reading of REA facts. */
export const readingLine = (
  component,
  claim,
  location = null,
  by = "Landscape",
) => ({
  claim,
  basis: "heuristic",
  source: by,
  location: where(component, location),
});
