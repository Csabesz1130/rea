import { createServer } from "node:http";

import { listNotes } from "./store.js";
import { summarize } from "./summarize.js";

const server = createServer(async (request, response) => {
  if (request.url === "/api/notes") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(await listNotes()));
    return;
  }
  if (request.url?.startsWith("/api/summarize/")) {
    const notes = await listNotes();
    const note = notes.find((candidate) =>
      request.url.endsWith(`/${candidate.id}`),
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ summary: await summarize(note) }));
    return;
  }
  response.statusCode = 404;
  response.end();
});

server.listen(Number(process.env.PORT ?? 8080));
