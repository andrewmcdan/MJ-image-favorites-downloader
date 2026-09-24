const assert = require("node:assert/strict");
const test = require("node:test");

const { createPuppeteerDiagnostics, envFlag } = require("../src/puppeteer/diagnostics");

test("envFlag accepts common enabled values", () => {
    process.env.TEST_PUPPETEER_FLAG = "yes";
    assert.equal(envFlag("TEST_PUPPETEER_FLAG"), true);
    process.env.TEST_PUPPETEER_FLAG = "false";
    assert.equal(envFlag("TEST_PUPPETEER_FLAG"), false);
    delete process.env.TEST_PUPPETEER_FLAG;
});

test("diagnostics are disabled by default and preserve launch options", () => {
    delete process.env.MJ_PUPPETEER_DEBUG;
    delete process.env.MJ_PUPPETEER_DEVTOOLS;
    delete process.env.MJ_PUPPETEER_KEEP_OPEN;
    const diagnostics = createPuppeteerDiagnostics({ projectRoot: process.cwd(), log: () => {} });
    assert.equal(diagnostics.enabled, false);
    assert.equal(diagnostics.keepOpen, false);
    assert.deepEqual(diagnostics.launchOptions({ headless: false }), {
        headless: false,
        devtools: undefined,
        dumpio: undefined,
    });
});

test("debug launch options enable Chromium output and DevTools", () => {
    process.env.MJ_PUPPETEER_DEBUG = "true";
    process.env.MJ_PUPPETEER_DEVTOOLS = "1";
    process.env.MJ_PUPPETEER_KEEP_OPEN = "on";
    const diagnostics = createPuppeteerDiagnostics({ projectRoot: process.cwd(), log: () => {} });
    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.keepOpen, true);
    assert.deepEqual(diagnostics.launchOptions({ headless: false }), {
        headless: false,
        devtools: true,
        dumpio: true,
    });
    delete process.env.MJ_PUPPETEER_DEBUG;
    delete process.env.MJ_PUPPETEER_DEVTOOLS;
    delete process.env.MJ_PUPPETEER_KEEP_OPEN;
});
