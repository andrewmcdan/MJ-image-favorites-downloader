const { spawn } = require("child_process");

function cleanupChromeProcesses({ platform = process.platform, spawnImpl = spawn, enabled = true, log = () => {} } = {}) {
    if (!enabled || platform !== "linux") return null;

    const cleanup = spawnImpl("killall", ["chrome"], { stdio: "ignore" });
    cleanup.once("error", (error) => log(`Linux Chrome cleanup could not start: ${error.message}`));
    cleanup.once("close", (code, signal) => {
        if (code !== 0 && code !== 1) log(`Linux Chrome cleanup exited with code ${code}${signal ? ` (${signal})` : ""}`);
    });
    return cleanup;
}

module.exports = { cleanupChromeProcesses };
