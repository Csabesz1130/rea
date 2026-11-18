// The Release Watch facts and readings Landscape consumes. Release Watch
// owns how REA Evidence becomes facts (which hosts a product contacts, which
// SDKs it uses, which MCP tools reach which processes, how Electron reads a
// window's options); Landscape only groups them into traits, so both tools
// read one product the same way.
export { collectSide } from "../../release-watch/src/collect.mjs";
export { discoverRelease } from "../../release-watch/src/discover.mjs";
export { createRea, resolveReaCommand } from "../../release-watch/src/rea.mjs";
export {
  analysisRecord,
  analysisSettings,
} from "../../release-watch/src/limits.mjs";
export {
  aiProviderOf,
  credentialOf,
  isAiEnvironmentKey,
  packageNameOf,
  processLibraryOf,
} from "../../release-watch/src/catalog.mjs";
export {
  examinedInPart,
  failedFiles,
} from "../../release-watch/src/facts/coverage.mjs";
export { isDeclarationPath } from "../../release-watch/src/facts/modules.mjs";
export {
  LOCAL,
  browserHosts,
  clientImports,
  contactSchemes,
  destinationsOf,
  isGuessSource,
  sourceModule,
} from "../../release-watch/src/rules/destinations.mjs";
export { packagesOf } from "../../release-watch/src/rules/dependencies.mjs";
export { shippedTokens } from "../../release-watch/src/rules/ai.mjs";
export { browserSdkUses } from "../../release-watch/src/rules/ai-placement.mjs";
export { toolConnections } from "../../release-watch/src/rules/mcp.mjs";
export {
  bundledToolDispatchers,
  registrationClaim,
  toolRegistrations,
} from "../../release-watch/src/rules/mcp-registrations.mjs";
export { commandText } from "../../release-watch/src/rules/process-commands.mjs";
export { windowSafeguards } from "../../release-watch/src/rules/windows.mjs";
export {
  mcpServers,
  sdkUses,
  surfacesOf,
} from "../../release-watch/src/surfaces.mjs";
export {
  localPath,
  localText,
  markdownCode,
  markdownText,
  printable,
  scrubDeep,
} from "../../release-watch/src/redact.mjs";
export {
  displayScript,
  displayUrl,
  hostOf,
  scriptHostOf,
} from "../../release-watch/src/urls.mjs";
