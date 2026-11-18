// Collects the products a map or a history names. Release Watch discovers
// each product's components and runs REA on each (collect.mjs), saving
// REA's Evidence under evidence/ as REA wrote it; products are analyzed
// `jobs` at a time.
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  collectSide,
  discoverRelease,
  examinedInPart,
} from "./release-watch.mjs";
import { productReader } from "./traits/index.mjs";

// A product is named by its manifest's product and version, else its first
// component's package name and version, else its path's base name.
const labelOf = (input, release, components) => {
  const found = components.map(({ pkg }) => pkg).find(Boolean);
  const name =
    release?.product ?? found?.name ?? path.basename(path.resolve(input));
  const version = release?.version ?? found?.version ?? null;
  return { name, version, label: version ? `${name} ${version}` : name };
};

// How much of one component REA examined. A capture alone is runtime
// traffic, not code.
const componentCoverage = (name, side) => {
  const { app } = side;
  if (!app)
    return {
      name,
      status: "none",
      files: [],
      reason: side.capture
        ? "only a runtime capture was analyzed, not code"
        : "REA produced no application facts",
    };
  if (app.coverage.semantic === "unavailable")
    return {
      name,
      status: "partial",
      files: [],
      reason: "REA produced no semantic graph",
    };
  const files = examinedInPart(app);
  return {
    name,
    status: files.length > 0 ? "partial" : "complete",
    files,
    reason:
      files.length > 0
        ? `REA examined ${files.length} file${files.length === 1 ? "" : "s"} only in part or not at all`
        : null,
  };
};

/**
 * How much of a product REA examined: "complete" when it examined every
 * file of every component in full, "none" when no component has
 * application facts, else "partial". What a product's code does where REA
 * did not look is unknown, not absent.
 */
export const productCoverage = (components) => {
  const parts = components.map(({ coverage }) => coverage);
  const status =
    parts.length > 0 && parts.every((part) => part.status === "complete")
      ? "complete"
      : parts.every((part) => part.status === "none")
        ? "none"
        : "partial";
  return { status, components: parts };
};

const discover = (input, errors) => {
  try {
    return discoverRelease(input);
  } catch (error) {
    errors.push({
      component: null,
      operation: "discover",
      code: "invalid_input",
      message: error.message,
    });
    return null;
  }
};

// What a map keeps of one collected component once its traits are read:
// coverage, the package it names and where its Evidence is, not its facts.
const componentRecord = (name, kind, side) => ({
  name,
  kind,
  coverage: componentCoverage(name, side),
  pkg: side.app?.package ?? null,
  evidence_file: side.appEvidence,
  evidence_id: side.app?.evidence_id ?? null,
  capture_file: side.capture?.file ?? null,
});

/**
 * Collect one product, reading each component's traits as soon as REA's
 * facts for it are projected, so a product of many components and a map
 * of many products hold one component's facts at a time per job.
 */
const collectProduct = async ({ rea, request, id, outDir, analysis }) => {
  const errors = [];
  const release = discover(request.input, errors);
  const reader = productReader();
  const components = [];
  for (const component of release?.components ?? []) {
    const side = await collectSide({
      rea,
      component: `${id}-${component.name}`,
      side: "product",
      label: `${id} ${component.name}`,
      target: component.target,
      outDir,
      errors,
      analysis,
    });
    reader.read({ name: component.name, side });
    components.push(
      componentRecord(component.name, component.target.kind, side),
    );
  }
  return {
    ...reader.finish(),
    id,
    role: request.role,
    input: request.input,
    ...labelOf(request.input, release, components),
    components,
    errors: errors.map(({ side: _side, component, ...error }) => ({
      ...error,
      component: component?.startsWith(`${id}-`)
        ? component.slice(id.length + 1)
        : component,
    })),
    coverage: productCoverage(components),
  };
};

/**
 * Collect every requested product (`[{ input, role }]`), `analysis.jobs`
 * at a time, in the order given; product ids are p1, p2, … in that order.
 * `onProduct` is called as each one finishes.
 */
export const collectProducts = async ({
  rea,
  requests,
  outDir,
  analysis,
  onProduct = () => {},
}) => {
  mkdirSync(path.join(outDir, "evidence"), { recursive: true });
  const products = Array.from({ length: requests.length });
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const index = next;
      next += 1;
      products[index] = await collectProduct({
        rea,
        request: requests[index],
        id: `p${index + 1}`,
        outDir,
        analysis,
      });
      onProduct(products[index]);
    }
  };
  const workers = Math.max(1, Math.min(analysis.jobs, requests.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return products;
};
