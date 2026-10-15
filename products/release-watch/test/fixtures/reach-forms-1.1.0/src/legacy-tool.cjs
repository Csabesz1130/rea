const { runLegacy: legacy } = require("./legacy.cjs");
module.exports = function registerLegacy(server) {
  server.registerTool("cjs_run", { description: "Run" }, async ({ cmd }) => {
    legacy(cmd);
    return { content: [] };
  });
};
