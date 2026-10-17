// What the whole release gained and lost, decided once from every prepared
// component before any component is graded.
import { connectionTotals } from "./rules/mcp.mjs";
import { registrationTotals } from "./rules/mcp-registrations.mjs";
import { releaseWindowPairing } from "./rules/window-pairing.mjs";
import { releaseMovesOf } from "./policy.mjs";
import { appKnown, unseenState } from "./sides.mjs";

/**
 * The manifest names of the components each side has no application facts
 * for although the release has them (`appKnown`): `{ left, right }`.
 */
const unknownSides = (prepared) => ({
  left: prepared
    .filter((component) => !appKnown(component.left))
    .map((component) => component.names.left),
  right: prepared
    .filter((component) => !appKnown(component.right))
    .map((component) => component.names.right),
});

/**
 * The host each capture of a component started its session on, its first
 * page load's, when the component takes it as its deployment: the address
 * the capture was made of. Hosts its redirects led through (an apex to www,
 * a sign-in hop through an identity provider) are the component's own
 * deployment only, since another party's host may serve that hop.
 */
const sessionHosts = (component) =>
  [component.left.capture, component.right.capture]
    .map((capture) => capture?.startHosts[0])
    .filter((host) => host !== undefined && component.deployment.has(host));

/**
 * The hosts that are the site itself for one prepared component, not a
 * destination: its own captures' deployment, and the host any capture of
 * the release started on (`release.deployment`).
 */
export const ownHosts = (release, component) =>
  new Set([...component.deployment, ...release.deployment]);

/**
 * What the whole release gained and lost, so a site that moved between
 * components is recognised as a move; how many tool-to-process connections
 * each capability has, and tool registrations the release makes, on each
 * side; the hosts the release's captures started on (the site itself for
 * every component, `sessionHosts`); the sides REA has no application facts
 * for; and each component's manifest names by its identity (`id`). Of a
 * component whose new side REA's facts do not describe, the old sites and
 * tools are unknown now, not gone: none is lost, and the totals leave it out
 * and say so (`leftOut`), counting as none the old calls of a counted
 * component whose old side they do not describe (`unknownBefore`).
 */
export const releaseContext = (prepared) => {
  const counted = prepared.filter((component) => appKnown(component.right));
  const apps = (side) => counted.map((component) => component[side].app);
  const unknown = unknownSides(prepared);
  return {
    moves: releaseMovesOf(
      prepared.map((component) => ({
        // The moves name each site's component by its identity.
        name: component.id,
        diff: component.diff,
        unseen: unseenState(component.right),
        left: component.left,
        right: component.right,
      })),
    ),
    connections: connectionTotals(counted),
    registrations: {
      ...registrationTotals(apps("left"), apps("right")),
      leftOut: unknown.right,
      unknownBefore: counted
        .filter((component) => !appKnown(component.left))
        .map((component) => component.names.left),
    },
    windows: releaseWindowPairing(prepared),
    deployment: new Set(prepared.flatMap(sessionHosts)),
    unknown,
    names: new Map(
      prepared.map((component) => [component.id, component.names]),
    ),
  };
};
