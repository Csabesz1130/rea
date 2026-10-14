const { exec } = require("node:child_process");

function runDiagnostics(command) {
  return new Promise((resolve) => {
    exec(command, { timeout: 10_000 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr });
    });
  });
}

module.exports = { runDiagnostics };
