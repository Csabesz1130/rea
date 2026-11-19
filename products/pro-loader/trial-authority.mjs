import { randomUUID } from "node:crypto";
import { config, trialAccountToken } from "./auth.mjs";

const denied = { available: async () => false, spend: async () => false };

// The issuer sees an authenticated subject and an opaque request UUID. The
// client never submits an Evidence ID, search string, source path or graph.
export function remoteTrial(request = fetch) {
  try {
    const cfg = config({ optional: true });
    if (!cfg) return null;
    if (!cfg.trial_endpoint) {
      return new URL(cfg.issuer).origin === "https://api.realizations.ai"
        ? denied
        : null;
    }
    const endpoint = new URL(cfg.trial_endpoint);
    if (endpoint.href !== new URL("/trial", cfg.issuer).href) return denied;
    async function check(method, body) {
      try {
        const response = await request(endpoint, {
          method,
          headers: {
            authorization: "Bearer " + trialAccountToken(cfg),
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return false;
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response.body ?? []) {
          bytes += chunk.length;
          if (bytes > 1024) return false;
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString());
        return method === "GET"
          ? Number.isInteger(value.remaining) &&
              value.remaining >= 1 &&
              value.remaining <= 3
          : value.granted === true;
      } catch {
        return false;
      }
    }
    return {
      available: () => check("GET"),
      spend: () => check("POST", JSON.stringify({ request_id: randomUUID() })),
    };
  } catch {
    return denied;
  }
}

export function upgradeCommand() {
  try {
    const profile = config({ optional: true });
    if (
      profile?.issuer === "https://api.realizations.ai" &&
      profile.trial_endpoint === profile.issuer + "/trial"
    )
      return "npx @realizations/rea login";
  } catch {}
  return "rea pro login";
}
