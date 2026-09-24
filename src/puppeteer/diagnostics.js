const fs = require("fs");
const path = require("path");

function envFlag(name, defaultValue = false) {
    const value = process.env[name];
    if (value == null) return defaultValue;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function createPuppeteerDiagnostics({ projectRoot, log = console.error } = {}) {
    const enabled = envFlag("MJ_PUPPETEER_DEBUG");
    const keepOpen = envFlag("MJ_PUPPETEER_KEEP_OPEN");
    const devtools = envFlag("MJ_PUPPETEER_DEVTOOLS");
    const debugDirectory = path.resolve(projectRoot || process.cwd(), process.env.MJ_PUPPETEER_DEBUG_DIR || "puppeteer-debug");

    const write = (message, details) => {
        if (!enabled) return;
        const suffix = details == null ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
        log(`[puppeteer] ${message}${suffix}`);
    };

    const launchOptions = (options = {}) => ({
        ...options,
        devtools: devtools || options.devtools,
        dumpio: enabled || options.dumpio,
    });

    async function capture(page, label, error) {
        if (!enabled) return;
        fs.mkdirSync(debugDirectory, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const safeLabel = String(label).replace(/[^a-z0-9_-]+/gi, "-");
        const basePath = path.join(debugDirectory, `${timestamp}-${safeLabel}`);
        const metadata = {
            timestamp: new Date().toISOString(),
            label,
            url: page && !page.isClosed() ? page.url() : null,
            error: error ? { name: error.name, message: error.message, stack: error.stack } : null,
        };
        fs.writeFileSync(`${basePath}.json`, JSON.stringify(metadata, null, 2));
        if (page && !page.isClosed()) {
            await page.screenshot({ path: `${basePath}.png`, fullPage: true }).catch((screenshotError) => {
                write("Unable to capture screenshot", screenshotError.message);
            });
        }
        write("Captured diagnostics", basePath);
    }

    function attachBrowser(browser) {
        if (!enabled || browser.__mjDiagnosticsAttached) return;
        browser.__mjDiagnosticsAttached = true;
        const process = browser.process();
        write("Browser launched", { pid: process?.pid ?? null, endpoint: browser.wsEndpoint() });
        browser.on("targetcreated", (target) => write("Target created", { type: target.type(), url: target.url() }));
        browser.on("targetdestroyed", (target) => write("Target destroyed", { type: target.type(), url: target.url() }));
        browser.on("disconnected", () => write("Browser disconnected", { exitCode: process?.exitCode ?? null, signalCode: process?.signalCode ?? null }));
        process?.once("exit", (code, signal) => write("Browser process exited", { code, signal }));
        process?.once("error", (error) => write("Browser process error", { message: error.message, stack: error.stack }));
    }

    function attachPage(page) {
        if (!enabled || !page || page.__mjDiagnosticsAttached) return;
        page.__mjDiagnosticsAttached = true;
        write("Page attached", { url: page.url() });
        page.on("error", (error) => {
            write("Page crashed", { message: error.message, stack: error.stack });
            void capture(page, "page-crash", error);
        });
        page.on("pageerror", (error) => write("Uncaught page error", { message: error.message, stack: error.stack }));
        page.on("requestfailed", (request) => write("Request failed", { url: request.url(), method: request.method(), error: request.failure()?.errorText }));
        page.on("response", (response) => {
            if (response.status() >= 400) write("HTTP error", { status: response.status(), url: response.url() });
        });
        page.on("console", (message) => {
            if (["error", "warning"].includes(message.type())) write(`Browser console ${message.type()}`, message.text());
        });
        page.on("close", () => write("Page closed"));
    }

    return { enabled, keepOpen, launchOptions, attachBrowser, attachPage, capture, write };
}

module.exports = { createPuppeteerDiagnostics, envFlag };
