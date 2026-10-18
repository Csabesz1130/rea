// AI traits of one component: which providers it calls (a host Release
// Watch attributes to a provider, an imported SDK that calls one provider's
// API itself, a provider URL its code holds), local models, environment
// keys, browser-side model calls and shipped credentials.
import { localModelPackage, localModelUrl } from "../catalog.mjs";
import { factLine, readingLine } from "../evidence.mjs";
import {
  aiProviderOf,
  browserHosts,
  browserSdkUses,
  credentialOf,
  displayUrl,
  hostOf,
  isAiEnvironmentKey,
  packageNameOf,
  sdkUses,
  shippedTokens,
} from "../release-watch.mjs";
import { TRAITS, isProviderTrait, providerTrait } from "./definitions.mjs";
import { hostLines, strengthOf } from "./destinations.mjs";
import { clientReason, isRuntimeImport, runtimeImports } from "./imports.mjs";

const providerHosts = (part, set) => {
  for (const [host, sources] of part.destinations) {
    const provider = aiProviderOf(host);
    if (provider)
      set.add(providerTrait(provider), {
        strength: strengthOf(sources),
        evidence: hostLines(part.name, sources),
        values: [host],
      });
  }
};

// SDKs any module imports; a package only installed beside the code is not
// a call.
const importedSdks = (app) => {
  const running = isRuntimeImport(app);
  return [...sdkUses(app)]
    .map(([name, use]) => ({
      name,
      sdk: use.sdk,
      facts: use.facts.filter(running),
    }))
    .filter((use) => use.facts.length > 0);
};

const providerSdks = (part, set) => {
  for (const { sdk, facts } of importedSdks(part.app)) {
    if (sdk.kind !== "ai" || !sdk.provider) continue;
    const [fact] = facts;
    set.add(providerTrait(sdk.provider), {
      evidence: [
        factLine(
          part.name,
          `${fact.data.module} imports ${fact.key}, the ${sdk.label}, which calls ${sdk.provider}'s API itself (Release Watch's catalog)`,
          fact,
        ),
      ],
    });
  }
};

// Provider and local model URLs the code holds that no destination ties to
// a request: the code names them, which only suggests a call.
const namedUrls = (part, set) => {
  for (const literal of part.app.urlLiterals) {
    const url = literal.data.url;
    const host = hostOf(url);
    const provider = aiProviderOf(host);
    if (provider && !part.destinations.has(host))
      set.add(providerTrait(provider), {
        strength: "likely",
        evidence: [
          readingLine(
            part.name,
            `${literal.data.module} holds ${displayUrl(url)}, ${provider}'s API, with no request REA ties to it`,
            literal.location,
          ),
        ],
        values: [host],
      });
    const server = localModelUrl(url);
    if (server)
      set.add(TRAITS.localModel, {
        strength: "likely",
        evidence: [
          readingLine(
            part.name,
            `${literal.data.module} holds ${displayUrl(url)}, ${server}'s default local address (Landscape's catalog)`,
            literal.location,
          ),
        ],
        values: [server],
      });
  }
};

const localPackages = (part, set) => {
  for (const fact of runtimeImports(part.app)) {
    const server = localModelPackage(packageNameOf(fact.key));
    if (server)
      set.add(TRAITS.localModel, {
        evidence: [
          factLine(
            part.name,
            `${fact.data.module} imports ${fact.key}, a client for ${server} (Landscape's catalog)`,
            fact,
          ),
        ],
        values: [server],
      });
  }
};

const environmentKeys = (part, set) => {
  for (const read of part.app.configReads)
    if (
      read.data.source_kind === "environment" &&
      isAiEnvironmentKey(read.data.key)
    )
      set.add(TRAITS.environmentKey, {
        evidence: [
          factLine(
            part.name,
            `${read.data.module} reads ${read.data.key} from the environment`,
            read,
          ),
        ],
        values: [read.data.key],
      });
};

const browserCalls = (part, set) => {
  const browser = browserHosts(part.side);
  for (const [host, sources] of part.destinations) {
    const provider = aiProviderOf(host);
    if (provider && browser.has(host))
      set.add(TRAITS.browserModel, {
        evidence: hostLines(part.name, sources),
        values: [provider],
      });
  }
  for (const [name, use] of browserSdkUses(part.app))
    set.add(TRAITS.browserModel, {
      evidence: use.facts.map((fact) =>
        factLine(
          part.name,
          `browser code ${fact.data.module} imports ${name}, which calls ${use.sdk.provider}'s API itself`,
          fact,
        ),
      ),
      values: [use.sdk.provider],
    });
};

// Credentials are cited by kind and place only; their values never leave
// the Evidence files.
const shippedKeys = (part, set) => {
  const tokens = [...shippedTokens(part.app).all];
  for (const token of tokens) {
    const kind = credentialOf(token)?.kind ?? "credential";
    const carrier = part.app.stringLiterals.find((literal) =>
      literal.data.value.includes(token),
    );
    set.add(TRAITS.shippedKey, {
      evidence: [
        carrier
          ? factLine(
              part.name,
              `${carrier.data.module} holds a literal in the format of a ${kind}`,
              carrier,
            )
          : readingLine(
              part.name,
              `the code holds a literal in the format of a ${kind}`,
            ),
      ],
      values: [kind],
    });
  }
};

// Model calls through an HTTP client REA does not model may not show.
const unmodeledCalls = (part, set) => {
  const reason = clientReason(part.app);
  if (reason === null) return;
  set.unknownBecause(TRAITS.hostedModel, reason);
  set.unknownBecause(TRAITS.localModel, reason);
};

/** Record one component's AI traits. */
export const readAi = (part, set) => {
  providerHosts(part, set);
  if (!part.app) return;
  unmodeledCalls(part, set);
  providerSdks(part, set);
  namedUrls(part, set);
  localPackages(part, set);
  environmentKeys(part, set);
  browserCalls(part, set);
  shippedKeys(part, set);
};

/**
 * The AI traits derived from a product's provider traits: a hosted model
 * when it calls any provider, several providers when it calls two or more
 * ("yes" only when REA facts show two).
 */
export const deriveAi = (set) => {
  const providers = set
    .entries()
    .filter((entry) => isProviderTrait(entry.definition.id));
  if (providers.length === 0) return;
  const sure = providers.filter((entry) => entry.yes.length > 0);
  const names = providers.map((entry) => entry.definition.provider);
  set.add(TRAITS.hostedModel, {
    strength: sure.length > 0 ? "yes" : "likely",
    evidence: [readingLine(null, `calls ${names.join(", ")}`, null)],
    values: names,
  });
  if (providers.length >= 2)
    set.add(TRAITS.severalProviders, {
      strength: sure.length >= 2 ? "yes" : "likely",
      evidence: [
        readingLine(null, `${providers.length} providers: ${names.join(", ")}`),
      ],
      values: names,
    });
};
