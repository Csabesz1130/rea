// Process execution not already explained by a more specific rule.
import {
  APP_SOURCE,
  absencePhrase,
  cite,
  newFacts,
  packResult,
} from "./shared.mjs";

export const processPack = (context) =>
  packResult(
    newFacts(context.diff.app.childProcesses)
      .filter(({ fact }) => !context.claimed.nodes.has(fact.node_id))
      .map(({ fact, status }) => ({
        rule: "RW-P01",
        severity: "high",
        title: `New process execution: ${fact.data.method}() in ${fact.data.module}`,
        summary: `${context.labels.right} creates child processes from ${fact.data.module}.`,
        why: "Process execution is a common step in supply-chain payloads and widens what the app can do on the machine it runs on.",
        recommendation:
          "Confirm the command source and that it cannot be influenced by web content, model output or network data.",
        evidence: [
          cite(
            `${fact.data.method}() child-process creation (${absencePhrase(status, context.labels.left)})`,
            fact,
            APP_SOURCE,
          ),
        ],
        unknowns:
          fact.data.command === null
            ? ["REA did not resolve the command statically."]
            : [],
      })),
  );
