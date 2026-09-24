const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { cleanupChromeProcesses } = require("../src/puppeteer/process-cleanup");

test("Chrome process cleanup is skipped outside Linux", () => {
    let spawnCalled = false;
    const result = cleanupChromeProcesses({
        platform: "win32",
        spawnImpl: () => {
            spawnCalled = true;
        },
    });
    assert.equal(result, null);
    assert.equal(spawnCalled, false);
});

test("Linux cleanup retains killall chrome with handled process events", () => {
    const child = new EventEmitter();
    let invocation;
    const result = cleanupChromeProcesses({
        platform: "linux",
        spawnImpl: (...args) => {
            invocation = args;
            return child;
        },
    });
    assert.equal(result, child);
    assert.deepEqual(invocation, ["killall", ["chrome"], { stdio: "ignore" }]);
    assert.doesNotThrow(() => child.emit("error", new Error("missing command")));
});

test("Chrome process cleanup can be disabled on Linux", () => {
    let spawnCalled = false;
    cleanupChromeProcesses({
        platform: "linux",
        enabled: false,
        spawnImpl: () => {
            spawnCalled = true;
        },
    });
    assert.equal(spawnCalled, false);
});
