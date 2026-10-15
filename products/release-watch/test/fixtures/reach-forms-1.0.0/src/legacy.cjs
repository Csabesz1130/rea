const { spawn } = require("node:child_process");
function runLegacy(command) {
  return spawn("/bin/sh", ["-c", command]);
}
module.exports = { runLegacy };
