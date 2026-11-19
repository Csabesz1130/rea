import { referenceCounts } from "./aggregates.mjs";

// Ingest normalized Evidence once so names and neighborhoods agree across editions.
function requiredString(value, field) {
  if (typeof value !== "string" || !value.length)
    throw new Error(`Invalid graph ${field}`);
  return value;
}

export async function ingestGraph(db, evidence, readEvidence, indexNode) {
  const node = db.prepare("INSERT INTO nodes(id,data) VALUES(?,?)");
  const edge = db.prepare(
    "INSERT INTO edges(src,dst,kind,resolution,ref) VALUES(?,?,?,?,?)",
  );
  let bounded = true;
  let nodes = 0,
    edges = 0;
  const meta = await readEvidence(
    evidence,
    (item) => {
      requiredString(item.id, "node id");
      requiredString(item.kind, "node kind");
      const json = JSON.stringify(item);
      if (json.length > 8192) bounded = false;
      const { lastInsertRowid } = node.run(item.id, json);
      indexNode?.(lastInsertRowid, item);
      nodes++;
    },
    (item) => {
      if (
        [
          item.source,
          item.target,
          item.relation,
          item.resolution,
          item.ref,
        ].some((v) => typeof v === "string" && v.length > 2048)
      )
        bounded = false;
      edge.run(
        ...[item.source, item.target, item.relation, item.resolution].map((v) =>
          requiredString(v, "relation"),
        ),
        item.ref ?? null,
      );
      edges++;
    },
  );
  if (meta.operation === "get_call_graph" && meta.direction === "backward")
    db.exec("UPDATE edges SET src=dst,dst=src");
  const ownershipEdges = db
    .prepare(`INSERT INTO edges(src,dst,kind,resolution)
    SELECT owner.id,n.id,'contains','function_node_id' FROM nodes n JOIN nodes owner ON owner.id=json_extract(n.data,'$.fn')
    WHERE owner.id!=n.id`)
    .run().changes;
  // Only a producer-supplied call-site -> function relation can support a function call.
  // Keep its direction, resolution, call-site ID and original Evidence relation ID.
  const functionCalls = db
    .prepare(`INSERT INTO edges(src,dst,kind,resolution,ref,via)
      SELECT owner.id,e.dst,'calls-function',e.resolution,e.ref,e.src FROM edges e
      JOIN nodes site ON site.id=e.src JOIN nodes callee ON callee.id=e.dst
      JOIN nodes owner ON owner.id=json_extract(site.data,'$.fn')
      WHERE e.kind='calls' AND json_extract(site.data,'$.kind')='call-site'
        AND json_extract(callee.data,'$.kind')='function' AND json_extract(owner.data,'$.kind')='function'`)
    .run().changes;

  return {
    ...meta,
    ...referenceCounts(db, meta, bounded),
    nodes,
    source_edges: edges,
    ownership_edges: ownershipEdges,
    derived_function_calls: functionCalls,
    edges: edges + ownershipEdges + functionCalls,
  };
}
