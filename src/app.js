/** About this project:
 *
 * This is a simple Express server that serves a dynamic page that displays a list of images.
 * The images come from a list of JSON files that are contained in a directory called "zips".
 * The images are hosted by CDN's and are not included in this repository.
 *
 * Use MJ archive downloader extension to obtain the zips that contain the JSON files.
 * Then place the zips in the zips directory.
 * When this server is running, visit http://localhost:3000/images to view the images.
 * On that page, click the checkmark or the X to decided weather to download the image or not.
 * The click Download Selected to download the images that were checked on the server side to selected folder.
 *
 * TODO:
 * - add weekly reset to selected count
 * - Add ability to manually upload images to the server
 *
 * //////////////// NEED to evaluate these TODO's ////////////////
 * 1. Add ExifTool capability to add metadata to images
 * 2. Add upscale capability to images using Ai-Upscale-Module
 * 3. Parse the output folder and omit images that have already been processed
 *      - This will require a database to store the image names, possibly just a json file
 * 4. add a page of general tools. ie. revering an image uuid to the original prompt / user (url, name, etc.)
 *
 *
 *
 * /////////////////////////////////////////////////////
 * Launch command for Ubuntu Server:
 * xvfb-run -a --server-args="-screen 0 1280x800x24 -ac -nolisten tcp -dpi 96 +extension RANDR" node app
 */
//
const fs = require("fs");
// const axios = require('axios');
const path = require("path");
const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });
process.chdir(PROJECT_ROOT);
const express = require("express");
const bodyParser = require("body-parser");
const sharp = require("sharp");
const app = express();
const port = process.env.mj_dl_server_port | 3000;
app.use(bodyParser.json({ limit: "100mb" }));
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const Upscaler = require("ai-upscale-module");
var removeRoute = require("express-remove-route");
const { registerRoutes } = require("./routes");
const { ImageInfo } = require("./models/image-info");
const { buildImageData: buildMidjourneyImageData, getObsoleteSingleOutputIds } = require("./midjourney/build-image-data");
const { createLogging } = require("./logging");
const { createDatabaseClass } = require("./services/database");
const { findMissingDownloadIds } = require("./services/download-verification");
const { DEFAULT_DOWNLOAD_BATCH_SIZE, DEFAULT_DOWNLOAD_CONCURRENCY, DOWNLOAD_RETRY_DELAYS_SECONDS, runInConcurrentChunks } = require("./services/download-queue");
const { validatePNG, waitSeconds } = require("./utils/runtime");
const { loadSettings: loadSettingsFile, saveSettings: saveSettingsFile } = require("./settings");
const { createPuppeteerDiagnostics, envFlag } = require("./puppeteer/diagnostics");
const { cleanupChromeProcesses } = require("./puppeteer/process-cleanup");
const { waitForLoginCompletion, triggerGoogleLogin, isAuthenticatedLikesProbe } = require("./puppeteer/login");

const SETTINGS_PATH = path.join(PROJECT_ROOT, "settings.json");
const MJ_SESSION_PATH = path.join(PROJECT_ROOT, "mjSession.json");

let logLevel = process.env.mj_dl_server_log_level ?? 0;
if (typeof logLevel === "string") logLevel = parseInt(logLevel);
let updateDB = process.env.mj_dl_server_updateDB ?? true;
if (typeof updateDB === "string") updateDB = updateDB === "true";
let verifyDownloadsOnStartup = process.env.mj_dl_server_verifyDlOnStartup ?? true;
if (typeof verifyDownloadsOnStartup === "string") verifyDownloadsOnStartup = verifyDownloadsOnStartup === "true";

let settings = {};

const { logger: winstonLogger, systemLogger, log0, log1, log2, log3, log4, log5, log6 } = createLogging({
    logLevel,
    updateDB,
    verifyDownloadsOnStartup,
    projectRoot: PROJECT_ROOT,
});
const puppeteerDiagnostics = createPuppeteerDiagnostics({ projectRoot: PROJECT_ROOT, log: log0 });
const cleanupOrphanedChrome = () =>
    cleanupChromeProcesses({
        enabled: envFlag("MJ_PUPPETEER_KILLALL_CHROME", true),
        log: log1,
    });
class DB_Error extends Error {
    static count = 0;
    constructor(message) {
        log5("DB_Error: " + message);
        super(message);
        this.name = "DB_Error";
        Error.captureStackTrace?.(this, DB_Error);
        systemLogger?.log("DB_Error", message);
        DB_Error.count++;
        log5("DB_Error count: " + DB_Error.count);
    }
}

class DownloadError extends Error {
    static count = 0;
    constructor(message) {
        log5("DownloadError: " + message);
        super(message);
        this.name = "DownloadError";
        Error.captureStackTrace?.(this, DownloadError);
        DownloadError.count++;
        log5("DownloadError count: " + DownloadError.count);
    }

    static resetCount() {
        DownloadError.count = 0;
        log5("Reset downloadError.count. New DownloadError count: " + DownloadError.count);
    }

    static sendErrorCountToSystemLogger() {
        systemLogger?.log("DownloadError!!! ", "DownloadError count: " + DownloadError.count);
        log5("Added DownloadError count to systemLogger");
    }
}


class PuppeteerClient {
    constructor() {
        log5("PuppeteerClient constructor called");
        this.browser = null;
        this.page = null;
        this.pageURL = null;
        this.loggedIntoMJ = false;
        this.loginInProgress = false;
        this.mj_cookies = null;
        this.mj_localStorage = null;
        this.mj_sessionStorage = null;
        // this.discord_cookies = null;
        // this.discord_localStorage = null;
        // this.discord_sessionStorage = null;
        // this.discordLoginComplete = false;
        this.googleLoginComplete = false;
    }

    async saveMidjourneySession() {
        if (!this.page) return false;
        this.mj_cookies = await this.page.cookies();
        this.mj_localStorage = await this.page.evaluate(() => ({ ...window.localStorage }));
        this.mj_sessionStorage = await this.page.evaluate(() => ({ ...window.sessionStorage }));
        fs.writeFileSync(MJ_SESSION_PATH, JSON.stringify({
            cookies: this.mj_cookies,
            localStorage: this.mj_localStorage,
            sessionStorage: this.mj_sessionStorage,
        }));
        return true;
    }

    /**
     * Loads the session data from the session files and attempts to restore the session.
     * @returns {Promise<void>} - nothing
     */
    async loadSession() {
        log5("loadSession() called");
        if (!fs.existsSync(MJ_SESSION_PATH)) {
            log0("LoadSession error. Session file not found.");
            throw new Error("Session file not found");
        }
        log6("Session file found. Loading session data.");
        const sessionData = JSON.parse(fs.readFileSync(MJ_SESSION_PATH, "utf8"));
        this.mj_cookies = sessionData.cookies;
        this.mj_localStorage = sessionData.localStorage;
        this.mj_sessionStorage = sessionData.sessionStorage;

        if (this.browser == null) {
            log1("Browser is null. Launching new browser.");
            this.browser = await puppeteer.launch(puppeteerDiagnostics.launchOptions({
                headless: false,
                defaultViewport: null,
                args: ["--enable-javascript"],
            }));
            puppeteerDiagnostics.attachBrowser(this.browser);
            this.browser.on("disconnected", () => {
                log6("Browser disconnected. Clearing Puppeteer state.");
                this.browser = null;
                this.page = null;
                this.loggedIntoMJ = false;
                this.loginInProgress = false;
                cleanupOrphanedChrome();
            });
            this.page = (await this.browser.pages())[0];
            puppeteerDiagnostics.attachPage(this.page);
        }

        log6("Restoring Midjourney cookies before navigation.");
        if (Array.isArray(this.mj_cookies) && this.mj_cookies.length) await this.page.setCookie(...this.mj_cookies);
        await this.page.goto("https://www.midjourney.com/explore?tab=likes", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });
        await this.page.evaluate(
            ({ localStorageData, sessionStorageData }) => {
                Object.entries(localStorageData || {}).forEach(([key, value]) => localStorage.setItem(key, value));
                Object.entries(sessionStorageData || {}).forEach(([key, value]) => sessionStorage.setItem(key, value));
            },
            { localStorageData: this.mj_localStorage, sessionStorageData: this.mj_sessionStorage },
        );
        await this.page.goto("https://www.midjourney.com/explore?tab=likes", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });

        const probe = await this.page.evaluate(async () => {
            const response = await fetch("/api/explore-likes?page=1&_ql=explore", {
                credentials: "include",
                headers: { accept: "application/json", "x-csrf-protection": "1" },
            });
            if (!response.ok) return { ok: false, status: response.status, isArray: false };
            try {
                return { ok: true, status: response.status, isArray: Array.isArray(await response.json()) };
            } catch {
                return { ok: true, status: response.status, isArray: false };
            }
        });
        if (!isAuthenticatedLikesProbe(probe)) {
            this.loggedIntoMJ = false;
            log0(`loadSession() error. Saved session rejected by Likes API (${probe?.status ?? "unknown"}).`);
            throw new Error("Session restore failed");
        }
        this.loggedIntoMJ = true;
        await this.saveMidjourneySession();
        log2("Midjourney session restored from mjSession.json; interactive login skipped.");
        log6("loadSession() complete.");
    }

    /**
     * Attempts to log into Midjourney. If the user is not logged in, it will attempt to log in using the credentials_cb function.
     * @param {CallableFunction} credentials_cb function to call to get login credentials
     * @returns {Promise<void>} - nothing
     */
    async loginToMJ(credentials_cb) {
        log5("loginToMJ() called");
        return new Promise(async (resolve, reject) => {
            if ((!this.loggedIntoMJ || this.browser == null) && !this.loginInProgress) {
                log6("Not logged into MJ and not currently logging in. Attempting to restore session.");
                // attempt to restore session
                this.loadSession()
                    .then(async () => {
                        await waitSeconds(5);
                        resolve();
                    })
                    .catch(async () => {
                        log1("Session restore failed. Attempting to log in.");
                        this.loginInProgress = true;
                        if (this.browser !== null) {
                            log6("Browser is not null. Closing browser.");
                            await this.browser.close();
                        }
                        log1("Launching new browser.");
                        this.browser = await puppeteer.launch(puppeteerDiagnostics.launchOptions({
                            headless: false,
                            defaultViewport: null,
                            args: ["--enable-javascript"],
                        }));
                        puppeteerDiagnostics.attachBrowser(this.browser);
                        log6("Browser launched.");
                        this.page = (await this.browser.pages())[0];
                        puppeteerDiagnostics.attachPage(this.page);
                        log6("Page set.");

                        log6("Setting up targetcreated event listener for discord.com/login.");
                        const handledAuthPages = new WeakSet();
                        const handleAuthTarget = async (target) => {
                            const authPage = await target.page().catch(() => null);
                            if (!authPage || handledAuthPages.has(authPage)) return;
                            const authUrl = authPage.url();
                            if (authUrl.includes("discord.com/login")) {
                                handledAuthPages.add(authPage);
                                log6("Target is discord.com/login. Logging into Discord.");
                                await this.loginToDiscord(authPage, credentials_cb);
                            }
                        };
                        this.browser.on("targetcreated", handleAuthTarget);
                        this.browser.on("targetchanged", handleAuthTarget);
                        this.browser.on("disconnected", () => {
                            log6("Browser disconnected. Clearing Puppeteer state.");
                            this.browser = null;
                            this.page = null;
                            this.loggedIntoMJ = false;
                            this.loginInProgress = false;
                            cleanupOrphanedChrome();
                        });

                        log6("Navigating to MJ home page.");
                        await this.page.goto("https://www.midjourney.com/", {
                            waitUntil: "domcontentloaded",
                            timeout: 60000,
                        });
                        log6("Navigated to MJ home page.");
                        // let html = await this.page.content();
                        await waitSeconds(5);
                        log6("Moving mouse to (0,0) and then to (100,100) to make sure the 'Sign In' button appears.");
                        await this.page.mouse.move(0, 0);
                        await this.page.mouse.move(100, 100);
                        await this.page.mouse.click(100, 100);
                        await this.page.mouse.wheel({ deltaY: 100 });
                        await waitSeconds(2);
                        await this.page.mouse.wheel({ deltaY: -200 });
                        log1("Opening the Midjourney Google login flow.");
                        const googleTargetPromise = this.browser.waitForTarget(
                            (target) => target.url().includes("accounts.google.com"),
                            { timeout: 60000 },
                        );
                        try {
                            await triggerGoogleLogin(this.page, () => waitSeconds(2));
                            log1("Waiting for the Google login window.");
                            const googleTarget = await googleTargetPromise;
                            const googleLoginPage = await googleTarget.page();
                            if (!googleLoginPage) throw new Error("Google login target did not provide a page");
                            puppeteerDiagnostics.attachPage(googleLoginPage);
                            log1("Google login window detected. Supplying credentials.");
                            await this.loginToGoogle(googleLoginPage, credentials_cb);
                        } catch (error) {
                            void googleTargetPromise.catch(() => {});
                            log0("Google login flow failed: " + error.message);
                            reject("Google login flow failed: " + error.message);
                            return;
                        }
                        const loginCompleted = await waitForLoginCompletion({
                            isComplete: () => Boolean(this.discordLoginComplete || this.googleLoginComplete),
                            wait: () => waitSeconds(1),
                        });
                        if (!loginCompleted) {
                            log0("loginToMJ() error. Timed out waiting for login.");
                            reject("Timed out waiting for login");
                            return;
                        }
                        await waitSeconds(5);
                        log6("Login process complete or failed.");
                        this.loginInProgress = false;
                        log6("Navigating to MJ home page.");
                        // await this.page.goto('https://www.midjourney.com/explore?tab=hot', { waitUntil: 'networkidle2', timeout: 60000 });
                        await waitSeconds(5);
                        log6("Navigated to MJ home page.");
                        log6("Checking to see if login was successful by checking the URL.");
                        this.pageURL = this.page.url();
                        if (this.pageURL.includes("https://www.midjourney.com/imagine") || this.pageURL.includes("https://www.midjourney.com/explore")) {
                            log6("Login successful.");
                            this.loggedIntoMJ = true;
                            log6("Getting/saving cookies and local/session storage.");
                            try {
                                log6("Writing mjSession.json file.");
                                await this.saveMidjourneySession();
                            } catch (err) {
                                log0("Error writing mjSession.json file. Error: " + err);
                            }

                            // log6(
                            //     "Navigating to discord.com/channels/@me to get discord cookies and local/session storage."
                            // );
                            // let discordPage = await this.browser.newPage();
                            // await discordPage.goto(
                            //     "https://discord.com/channels/@me"
                            // );
                            // await waitSeconds(2);
                            // log6(
                            //     "Getting/saving cookies and local/session storage."
                            // );
                            // this.discord_cookies = await discordPage.cookies();
                            // this.discord_localStorage =
                            //     await discordPage.evaluate(() => {
                            //         return window.localStorage;
                            //     });
                            // this.discord_sessionStorage =
                            //     await discordPage.evaluate(() => {
                            //         return window.sessionStorage;
                            //     });
                            // try {
                            //     log6("Writing discordSession.json file.");
                            //     fs.writeFileSync(
                            //         "discordSession.json",
                            //         JSON.stringify({
                            //             cookies: this.discord_cookies,
                            //             localStorage: this.discord_localStorage,
                            //             sessionStorage:
                            //                 this.discord_sessionStorage,
                            //         })
                            //     );
                            // } catch (err) {
                            //     log0(
                            //         "Error writing discordSession.json file. Error: " +
                            //             err
                            //     );
                            // }
                            // await waitSeconds(15);
                            // log6("Closing discord page.");
                            // await discordPage?.close();
                            resolve();
                        } else {
                            this.loggedIntoMJ = false;
                            log0("loginToMJ() error. Login failed.");
                            reject("Login failed");
                        }
                    })
                    .catch((error) => {
                        this.loginInProgress = false;
                        this.loggedIntoMJ = false;
                        log0("loginToMJ() browser or navigation error: " + error.message);
                        reject(error);
                    });
                if (this.loggedIntoMJ) {
                    log2("Already logged into MJ");
                    await this.page.goto("https://www.midjourney.com/imagine", {
                        waitUntil: "domcontentloaded",
                        timeout: 60000,
                    });
                    resolve();
                }
            }
        });
    }

    async loginToGoogle(googleLoginPage, credentials_cb) {
        log5("loginToGoogle() called");
        try {
            const credentials = await credentials_cb();
            const username = credentials.uName;
            const password = credentials.pWord;
            if (username === "" || password === "") {
                log1("loginToGoogle() error. Username or password is empty.");
                this.googleLoginComplete = false;
                return;
            }

            log1("Google login: waiting for the email field.");
            const emailSelector = 'input[type="email"], input#identifierId';
            await googleLoginPage.waitForSelector(emailSelector, { visible: true, timeout: 60000 });
            await googleLoginPage.click(emailSelector);
            await googleLoginPage.type(emailSelector, username, { delay: 45 });
            await googleLoginPage.keyboard.press("Enter");

            log1("Google login: email submitted; waiting for the password field.");
            const passwordSelector = 'input[type="password"]';
            await googleLoginPage.waitForSelector(passwordSelector, { visible: true, timeout: 60000 });
            await googleLoginPage.click(passwordSelector);
            await googleLoginPage.type(passwordSelector, password, { delay: 45 });
            await googleLoginPage.keyboard.press("Enter");

            log1("Google login: password submitted; waiting for Midjourney redirect.");
            const completed = await waitForLoginCompletion({
                isComplete: () => googleLoginPage.isClosed() || !googleLoginPage.url().includes("accounts.google.com"),
                wait: () => waitSeconds(1),
            });
            if (!completed) throw new Error("Timed out waiting for Google to return to Midjourney");
            this.googleLoginComplete = true;
            log1("Google login window completed.");
        } catch (error) {
            this.googleLoginComplete = false;
            await puppeteerDiagnostics.capture(googleLoginPage, "google-login-error", error);
            log0("loginToGoogle() error: " + error.message);
            throw error;
        }
    }

    /**
     * Attempts to log into Discord. If the user is not logged in, it will attempt to log in using the credentials_cb function.
     * @param {puppeteer page} discordLoginPage
     * @param {CallableFunction} credentials_cb
     * @returns nothing
     */
    async loginToDiscord(discordLoginPage, credentials_cb) {
        log5("loginToDiscord() called");
        let credentials = await credentials_cb();
        let username = credentials.uName;
        let password = credentials.pWord;
        if (username === "" || password === "") {
            log1("loginToDiscord() error. Username or password is empty.");
            this.discordLoginComplete = false;
            return;
        }
        log6("Logging into Discord with the supplied credentials.");
        let MFA_cb = credentials.mfaCb;
        await waitSeconds(1);
        log6("Typing username and password.");
        await discordLoginPage.waitForSelector('input[name="email"]');
        let typingRandomTimeMin = 0.03;
        let typingRandomTimeMax = 0.15;
        for (let i = 0; i < username.length; i++) {
            await discordLoginPage.type('input[name="email"]', username.charAt(i));
            let randomTime = Math.random() * typingRandomTimeMin + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }
        await discordLoginPage.keyboard.press("Tab");
        for (let i = 0; i < password.length; i++) {
            await discordLoginPage.type('input[name="password"]', password.charAt(i));
            let randomTime = Math.random() * typingRandomTimeMin + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }
        log6("Username and password typed.");
        await waitSeconds(1);
        log6("Clicking login button.");
        await discordLoginPage.click('button[type="submit"]');
        log6("Login button clicked. Waiting for MFA code input field");
        discordLoginPage
            .waitForSelector('input[placeholder="6-digit authentication code"]', { timeout: 60000 })
            .then(async () => {
                let data = "";
                if (MFA_cb !== null) {
                    log6("MFA_cb is not null. Calling MFA_cb.");
                    data = await MFA_cb();
                }
                if (data === "") {
                    log1("loginToDiscord() error. MFA code is empty.");
                    this.discordLoginComplete = false;
                    return;
                }
                log6("Typing MFA code.");
                await discordLoginPage.type('input[placeholder="6-digit authentication code"]', data.toString());
                log6("MFA code typed.");
                log6("Clicking submit button.");
                await discordLoginPage.click('button[type="submit"]');
                await waitSeconds(3);
                log6("Submit button clicked.");
                log6("Waiting for authorize button.");
                await discordLoginPage.waitForSelector("button ::-p-text(Authorize)", { timeout: 60000 });
                log6("Authorize button found. Clicking authorize button.");
                await discordLoginPage.click("button ::-p-text(Authorize)");
                await waitSeconds(3);
                log6("Authorize button clicked.");
                this.discordLoginComplete = true;
            })
            .catch(() => {
                this.discordLoginComplete = true;
            });
    }

    async killBrowser() {
        log5("killBrowser() called");
        if (puppeteerDiagnostics.keepOpen) {
            puppeteerDiagnostics.write("Keeping browser open because MJ_PUPPETEER_KEEP_OPEN is enabled");
            return;
        }
        if (this.browser !== null) {
            log6("Browser is not null. Closing browser.");
            await this.browser.close();
            this.browser = null;
            this.page = null;
            this.loggedIntoMJ = false;
            this.loginInProgress = false;
            this.discordLoginComplete = false;
            this.discord_cookies = null;
            this.discord_localStorage = null;
            this.discord_sessionStorage = null;
            this.mj_cookies = null;
            this.mj_localStorage = null;
            this.mj_sessionStorage = null;
            this.pageURL = null;
            cleanupOrphanedChrome();
        }
    }

    /**
     * Attempts to get the user's jobs data from Midjourney. If the user is not logged in, it will attempt to log in.
     * If the user is logged in, but the login is in progress, it will wait for the login to complete before attempting to get the user's jobs data.
     * If the user is logged in, but the login is not in progress, it will attempt to get the user's jobs data.
     * @returns {Promise<object>} - the user's jobs data
     */
    getUsersJobsData() {
        log5("getUsersJobsData() called");
        return new Promise(async (resolve, reject) => {
            if (!this.loggedIntoMJ || this.browser == null) {
                log6("Not logged into MJ. Attempting to log in.");
                let uNamePWordCb = async () => {
                    let uName = process.env.GOOGLE_LOGIN_EMAIL || "";
                    let pWord = process.env.GOOGLE_LOGIN_PASSWORD || "";
                    let mfaCb = null;
                    if (uName && pWord) {
                        log2("Using Google login credentials from the environment.");
                        return { uName, pWord, mfaCb };
                    }
                    systemLogger?.log("Not logged into MJ. Please send login credentials.");
                    /**
                     * GET /login/:username/:password
                     * Login endpoint for logging into Midjourney
                     * @param {string} username - username for Midjourney
                     * @param {string} password - password for Midjourney
                     * @returns {string} - "ok" once credentials have been entered
                     */
                    app.get("/login/:username/:password", async (req, res) => {
                        log3("GET /login/:username/:password called");
                        let { username, password } = req.params;
                        if (password.includes("%23")) password = password.replace("%23", "#");
                        log6("Login credentials received.");
                        uName = username;
                        pWord = password;
                        mfaCb = async () => {
                            systemLogger?.log("MFA code requested. Please send MFA code.");
                            let retData = "";
                            /**
                             * GET /mfa/:data
                             * Endpoint for getting the MFA code from the user
                             * @param {string} data - the MFA code
                             * @returns {string} - the MFA code
                             */
                            app.get("/mfa/:data", (req, res) => {
                                log3("GET /mfa/:data called");
                                const { data } = req.params;
                                log6("MFA code: " + data);
                                res.send(data);
                                retData = data;
                            });
                            let waitCount = 0;
                            while (retData == "") {
                                if (waitCount++ > 60 * 5) {
                                    log1("getUsersJobsData(): Timed out waiting for MFA code.");
                                    break;
                                }
                                await waitSeconds(1);
                            }
                            return retData;
                        };
                        res.send("ok");
                    });
                    let waitCount = 0;
                    while (uName == "" || pWord == "") {
                        if (waitCount++ > 60 * 5) {
                            log1("getUsersJobsData(): Timed out waiting for login credentials.");
                            break;
                        }
                        await waitSeconds(1);
                    }
                    return { uName, pWord, mfaCb };
                };
                await this.loginToMJ(uNamePWordCb).catch((err) => {
                    log0("getUsersJobsData() error. Not logged into MJ. Error: " + err);
                    reject("Not logged into MJ. Error: " + err);
                });
            }
            let waitCount = 0;
            while (this.loginInProgress) {
                await waitSeconds(1);
                waitCount++;
                if (waitCount > 60 * 5) {
                    log0("getUsersJobsData() error. Login in progress for too long");
                    reject("Login in progress for too long");
                }
            }
            await waitSeconds(2);
            this.page
                ?.goto("https://www.midjourney.com/imagine", {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                })
                .then(async () => {
                    log6("Navigated to MJ home page.");
                    if (!this.loggedIntoMJ) reject("Not logged into MJ");
                    log6("Getting user's jobs data.");
                    let data = await this.page.evaluate(async () => {
                        let userUUID = "f66ba656-fc1b-4366-8ec8-cf52cbc47309";
                        let numberOfJobsReturned = 0;
                        let cursor = "";
                        // "gAAAAABpMKZY7fekYoTWszkM7wX--qQsu0wv-VxG3MofCD5qIWq6v4Wr2yo2eLqD9LWX2DiT6ZO2A6-l9KeOwDwaP-AKl8_mALTADeDPpxFwDlURNTrQGbUQu3MSuAeC6jLE_MRCqgPNc-kAAb59IJBmbRpYy4M6NFMIN_9__kFV8G_3EYVNDiTHc62B-iMsa6nVpIsARygFvCcX8FppBKNa4ihsZqo6LcNF3W2ZA9Q_bSaEkAqzoIU%3D";
                        let loopCount = 0;
                        let returnedData = [];
                        do {
                            let cookies = document.cookie;
                            let response = await fetch("https://www.midjourney.com/api/imagine?user_id=" + userUUID + "&page_size=10000" + (cursor == "" ? "" : "&cursor=" + cursor), {
                                headers: {
                                    accept: "*/*",
                                    "accept-language": "en-US,en;q=0.9",
                                    "cache-control": "no-cache",
                                    "content-type": "application/json",
                                    pragma: "no-cache",
                                    "sec-ch-ua": '"Chromium";v="127", "Google Chrome";v="127", "Not)A;Brand";v="127"',
                                    "sec-ch-ua-mobile": "?0",
                                    "sec-ch-ua-platform": '"Windows"',
                                    "sec-fetch-dest": "empty",
                                    "sec-fetch-mode": "cors",
                                    "sec-fetch-site": "same-origin",
                                    "x-csrf-protection": "1",
                                    cookie: cookies,
                                    Referer: "https://www.midjourney.com/imagine",
                                    "Referrer-Policy": "origin-when-cross-origin",
                                },
                                referrer: "https://www.midjourney.com/imagine",
                                referrerPolicy: "origin-when-cross-origin",
                                body: null,
                                method: "GET",
                                mode: "cors",
                                credentials: "include",
                            });

                            let data = await response.json();
                            // log2({data});
                            dataTemp = data;
                            if (data.data.length == 0) break;
                            numberOfJobsReturned = data.data.length;
                            // put all the returned data into the returnedData array
                            returnedData.push(...data.data);
                            cursor = data.cursor;
                            loopCount++;
                            if (loopCount > 100) {
                                break; // if we've returned more than 1,000,000 jobs, there's probably something wrong, and there's gonna be problems
                            }
                        } while (numberOfJobsReturned == 10000);
                        return returnedData;
                    });
                    resolve(data);
                })
                .catch((err) => {
                    log0("getUsersJobsData() error. Error: " + err);
                    systemLogger?.log("getUsersJobsData() error. Error: " + err);
                    reject("Error: " + err);
                });
        });
    }

    getUsersLikesData() {
        log5("getUsersLikesData() called");
        return new Promise(async (resolve, reject) => {
            if (!this.loggedIntoMJ || this.browser == null) {
                log6("Not logged into MJ. Attempting to log in.");
                let uNamePWordCb = async () => {
                    let uName = process.env.GOOGLE_LOGIN_EMAIL || "";
                    let pWord = process.env.GOOGLE_LOGIN_PASSWORD || "";
                    let mfaCb = null;
                    if (uName && pWord) {
                        log2("Using Google login credentials from the environment.");
                        return { uName, pWord, mfaCb };
                    }
                    systemLogger?.log("Not logged into MJ. Please send login credentials.");
                    /**
                     * GET /login/:username/:password
                     * Login endpoint for logging into Midjourney
                     * @param {string} username - username for Midjourney
                     * @param {string} password - password for Midjourney
                     * @returns {string} - "ok" once credentials have been entered
                     */
                    app.get("/login/:username/:password", async (req, res) => {
                        log3("GET /login/:username/:password called");
                        const { username, password } = req.params;
                        log6("Login credentials received.");
                        uName = username;
                        pWord = password;
                        mfaCb = async () => {
                            systemLogger?.log("MFA code requested. Please send MFA code.");
                            let retData = "";
                            /**
                             * GET /mfa/:data
                             * Endpoint for getting the MFA code from the user
                             * @param {string} data - the MFA code
                             * @returns {string} - the MFA code
                             */
                            app.get("/mfa/:data", (req, res) => {
                                log3("GET /mfa/:data called");
                                const { data } = req.params;
                                log6("MFA code: " + data);
                                res.send(data);
                                retData = data;
                            });
                            let waitCount = 0;
                            while (retData == "") {
                                if (waitCount++ > 60 * 5) {
                                    log1("getUsersLikesData(): Timed out waiting for MFA code.");
                                    break;
                                }
                                await waitSeconds(1);
                            }
                            return retData;
                        };
                        res.send("ok");
                    });
                    let waitCount = 0;
                    while (uName == "" || pWord == "") {
                        if (waitCount++ > 60 * 5) {
                            log1("getUsersLikesData(): Timed out waiting for login credentials.");
                            break;
                        }
                        await waitSeconds(1);
                    }
                    return { uName, pWord, mfaCb };
                };
                await this.loginToMJ(uNamePWordCb).catch((err) => {
                    log0("getUsersLikesData() error. Not logged into MJ. Error: " + err);
                    reject("Not logged into MJ. Error: " + err);
                });
            }
            let waitCount = 0;
            while (this.loginInProgress) {
                await waitSeconds(1);
                waitCount++;
                if (waitCount > 60 * 5) {
                    log0("getUsersLikesData() error. Login in progress for too long");
                    reject("Login in progress for too long");
                }
            }
            await waitSeconds(2);
            this.page
                ?.goto("https://www.midjourney.com/explore?tab=likes", {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                })
                .then(async () => {
                    log6("Navigated to MJ home page.");
                    log6("Getting user's likes data.");
                    let data = await this.page.evaluate(async () => {
                        const returnedData = [];
                        const maxPages = 10000;

                        for (let page = 1; page <= maxPages; page++) {
                            const response = await fetch(`/api/explore-likes?page=${page}&_ql=explore`, {
                                method: "GET",
                                credentials: "include",
                                headers: {
                                    accept: "application/json",
                                    "x-csrf-protection": "1",
                                },
                            });

                            if (!response.ok) {
                                const responseText = await response.text();
                                throw new Error(`Likes API returned ${response.status}: ${responseText.slice(0, 300)}`);
                            }

                            const pageData = await response.json();
                            if (!Array.isArray(pageData)) {
                                throw new TypeError("Likes API response was not an array");
                            }

                            // Midjourney's likes pages are not guaranteed to contain 50
                            // records. A short page can still be followed by more data, so
                            // only an empty response marks the end of pagination.
                            if (pageData.length === 0) return returnedData;
                            returnedData.push(...pageData);
                        }

                        throw new Error(`Likes API exceeded the ${maxPages}-page safety limit`);
                    });
                    if (data.error) {
                        log0("getUsersLikesData() error. Error: " + data.error);
                        systemLogger?.log("getUsersLikesData() error. Error: " + data.error);
                        reject(data.error);
                        return;
                    }
                    resolve(data);
                })
                .catch(async (err) => {
                    await puppeteerDiagnostics.capture(this.page, "likes-sync-error", err);
                    log0("getUsersLikesData() error. Error: " + err);
                    systemLogger?.log("getUsersLikesData() error. Error: " + err);
                    reject("Error: " + err);
                });
        });
    }

    /**
     * @param {string} jobID
     * @returns {Promise<object>} - the job status data
     */
    getSingleJobStatus(jobID) {
        log5("getSingleJobStatus() called");
        return new Promise(async (resolve, reject) => {
            if (!this.loggedIntoMJ) reject("Not logged into MJ");
            if (this.loginInProgress) reject("Login in progress");
            log6("Navigating to MJ home page.");
            await this.page.goto("https://www.midjourney.com/imagine", {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            log6("Navigated to MJ home page.");
            log6("Getting job status data for jobID: " + jobID);
            let data = await this.page.evaluate(async (jobID) => {
                let res1 = await fetch("https://www.midjourney.com/api/app/job-status", {
                    headers: {
                        accept: "*/*",
                        "accept-language": "en-US,en;q=0.9",
                        "content-type": "application/json",
                        "sec-ch-ua": '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
                        "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": '"Windows"',
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-origin",
                        "x-csrf-protection": "1",
                        Referer: "https://www.midjourney.com/imagine",
                        "Referrer-Policy": "origin-when-cross-origin",
                    },
                    body: '{"jobIds":["' + jobID + '"]}',
                    method: "POST",
                });
                let res2 = await res1.json();
                if (res2.length > 0) return res2[0];
                else return null;
            }, jobID);
            resolve(data);
        });
    }
}

class ServerStatusMonitor {
    constructor(SystemLogger, PuppeteerClient, DownloadManager, DatabaseManager, UpscaleManager, DatabaseUpdateManager) {
        log5("ServerStatusMonitor constructor called");
        this.systemLogger = SystemLogger;
        this.puppeteerClient = PuppeteerClient;
        this.downloadManager = DownloadManager;
        this.dbClient = DatabaseManager;
        this.upscalerManager = UpscaleManager;
        this.databaseUpdateManager = DatabaseUpdateManager;
        this.serverStartTime = new Date();
    }

    async checkServerStatus() {
        log5("checkServerStatus() called");
        let status = {};
        status.serverStartTime = this.serverStartTime;
        status.upTime = new Date() - this.serverStartTime;
        // convert status.upTime into a human readable format
        status.upTimeFormatted = "";
        let upTimeSeconds = Math.floor(status.upTime / 1000);
        let upTimeMinutes = Math.floor(upTimeSeconds / 60);
        let upTimeHours = Math.floor(upTimeMinutes / 60);
        let upTimeDays = Math.floor(upTimeHours / 24);
        upTimeSeconds = upTimeSeconds % 60;
        upTimeMinutes = upTimeMinutes % 60;
        upTimeHours = upTimeHours % 24;
        status.upTimeFormatted = (upTimeDays > 0 ? upTimeDays + " days, " : "") + (upTimeHours > 0 ? upTimeHours + " hours, " : "") + (upTimeMinutes > 0 ? upTimeMinutes + " minutes, " : "") + upTimeSeconds + " seconds";

        status.numberOfLogEntries = this.systemLogger.getNumberOfEntries();

        status.database = {};
        status.database.numberOfImages = await this.dbClient.countImagesTotal();
        status.database.numberOfImagesDownloaded = await this.dbClient.countImagesDownloaded();
        status.database.errorCount = DB_Error.count;

        status.puppeteerClient = {};
        status.puppeteerClient.loggedIntoMJ = this.puppeteerClient.loggedIntoMJ;
        status.puppeteerClient.loginInProgress = this.puppeteerClient.loginInProgress;

        status.downloadManager = {};
        status.downloadManager.downloadsInProgress = this.downloadManager.concurrentDownloads;
        status.downloadManager.timeToDownload = this.downloadManager.timeToDownload;
        status.downloadManager.runEnabled = this.downloadManager.downloadRunEnabled;
        status.downloadManager.downloadLocation = this.downloadManager.downloadLocation;

        status.upscalerManager = {};
        status.upscalerManager.upscaleInProgress = this.upscalerManager.upscaleInProgress;
        status.upscalerManager.runningUpscales = this.upscalerManager.runningUpscales;
        status.upscalerManager.queuedUpscales = this.upscalerManager.queuedUpscales;
        status.upscalerManager.timeToUpscale = this.upscalerManager.timeToUpscale;
        status.upscalerManager.runEnabled = this.upscalerManager.runEnabled;

        status.databaseUpdateManager = {};
        status.databaseUpdateManager.updateInProgress = this.databaseUpdateManager.updateInProgress;
        status.databaseUpdateManager.timeToUpdate = this.databaseUpdateManager.timeToUpdate;
        status.databaseUpdateManager.runEnabled = this.databaseUpdateManager.runEnabled;
        log6("checkServerStatus() complete");
        return status;
    }
}

const Database = createDatabaseClass({ DB_Error, log0, log1, log2, log5, log6 });



class DatabaseUpdateManager {
    static updateInProgress_static = false;
    constructor(DatabaseManager = null, SystemLogger = null, PuppeteerClient = null) {
        log5("DatabaseUpdateManager constructor called");
        log6("DatabaseUpdateManager constructor\nDatabaseManager: " + DatabaseManager + "\nSystemLogger: " + SystemLogger + "\nPuppeteerClient: " + PuppeteerClient);
        this.dbClient = DatabaseManager;
        this.puppeteerClient = PuppeteerClient;
        this.systemLogger = SystemLogger;
        this.updateInProgress = false;
        this.runTimeout = null;
        this.timeToUpdate = 0; // minutes after midnight
        this.runEnabled = false;
        this.start();
        log6("DatabaseUpdateManager constructor complete");
    }

    start() {
        log5("DatabaseUpdateManager.start() called");
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        log6("now: " + now);
        let timeToUpdate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToUpdate / 60, this.timeToUpdate % 60, 0, 0);
        log6("timeToUpdate: " + timeToUpdate);
        let timeUntilUpdate = timeToUpdate - now;
        log6("timeUntilUpdate: " + timeUntilUpdate);
        if (timeUntilUpdate < 0) timeUntilUpdate += 1000 * 60 * 60 * 24;
        log6("timeUntilUpdate: " + timeUntilUpdate);
        this.runTimeout = setTimeout(() => this.run(), timeUntilUpdate);
        log6("DatabaseUpdateManager.start() complete");
    }

    async run() {
        log5("DatabaseUpdateManager.run() called");
        if (!this.runEnabled) {
            log1("DatabaseUpdateManager.run() warning: Run is disabled. Run will not start.");
            this.start();
            return;
        }
        if (DownloadManager.downloadInProgress_static === true) {
            log1("DatabaseUpdateManager.run() warning: Download is in progress. Will try again in 5 minutes.");
            this.runTimeout = setTimeout(() => this.run(), 1000 * 60 * 5);
            return;
        }
        if (this.updateInProgress === true) return;
        this.updateInProgress = true;
        DatabaseUpdateManager.updateInProgress_static = true;
        log6("DatabaseUpdateManager.run() updateInProgress: " + this.updateInProgress);
        await this.updateUsersJobs();
        await this.updateUsersLikes();
        log6("DatabaseUpdateManager.run() complete");
    }
    async updateUsersJobs() {
        // return;
        log5("DatabaseUpdateManager.updateUsersJobs() called");
        await this.puppeteerClient
            .getUsersJobsData()
            .then(async (data) => {
                log4(typeof data);
                log4("Size of data: ", data.length, "\nCalling buildImageData()");
                let imageData = buildImageData(data);
                log2("Size of data: ", imageData.length, "\nDone building imageData\nUpdating database");
                if (updateDB) {
                    const startedAt = Date.now();
                    const removed = await imageDB.deleteObsoleteUnprocessedImages(getObsoleteSingleOutputIds(data));
                    const result = await imageDB.bulkUpsertImages(imageData);
                    log2(`Created-images database update complete: ${result.updated} rows in ${result.batches} batches, ${removed} obsolete rows removed (${Date.now() - startedAt} ms)`);
                }
                // log2("Done updating database");
            })
            .catch((err) => {
                log2(err);
                this.systemLogger?.log("Error getting user's jobs data", err);
                log0(["DatabaseUpdateManager.run() error: Error getting user's jobs data", err]);
            })
            .finally(() => {
                log6("DatabaseUpdateManager.run() complete");
                // this.updateInProgress = false;
                // DatabaseUpdateManager.updateInProgress_static = false;
                // this.puppeteerClient.killBrowser();
                // this.start();
            });
    }
    async updateUsersLikes() {
        log5("DatabaseUpdateManager.updateUsersLikes() called");
        await this.puppeteerClient
            .getUsersLikesData()
            .then(async (data) => {
                log4("typeof data: " + typeof data);
                log4("Size of data: ", data.length, "\nCalling buildImageData()");
                let imageData = buildImageData(data, { likedOnly: true });
                log2("Size of data: ", imageData.length, "\nDone building imageData\nUpdating database");
                if (updateDB) {
                    const startedAt = Date.now();
                    const result = await imageDB.bulkUpsertImages(imageData);
                    log2(`Liked-images database update complete: ${result.updated} rows in ${result.batches} batches (${Date.now() - startedAt} ms)`);
                }
                log2("Done updating database");
            })
            .catch((err) => {
                log2(err);
                this.systemLogger?.log("Error getting user's likes data", err);
                log0(["DatabaseUpdateManager.run() error: Error getting user's likes data", err]);
            })
            .finally(() => {
                log6("DatabaseUpdateManager.run() complete");
                this.updateInProgress = false;
                DatabaseUpdateManager.updateInProgress_static = false;
                this.puppeteerClient.killBrowser();
                this.start();
            });
    }
}

class DatabaseUpdateManualData {
    constructor(DatabaseManager = null, SystemLogger = null) {
        log5("DatabaseUpdateManualData constructor called");
        log6("DatabaseUpdateManualData constructor\nDatabaseManager: " + DatabaseManager + "\nSystemLogger: " + SystemLogger);
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
    }

    async update(jsonData) {
        log5("DatabaseUpdateManualData.update() called");
        if (!jsonData || (!Array.isArray(jsonData.data) && !Array.isArray(jsonData))) {
            log1("DatabaseUpdateManualData.update() warning: invalid data");
            return false;
        }
        let imageData;
        try {
            if (jsonData.data) imageData = buildImageData(jsonData.data);
            else imageData = buildImageData(jsonData);
        } catch (err) {
            log0(["DatabaseUpdateManualData.update() error: Error building image data", err]);
            this.systemLogger?.log("Error building image data", err);
            return false;
        }
        try {
            await this.dbClient.bulkUpsertImages(imageData);
        } catch (err) {
            log0(["DatabaseUpdateManualData.update() error inserting images", err]);
            this.systemLogger?.log("Error inserting images", err);
            return false;
        }
        log6("DatabaseUpdateManualData.update() complete");
        return true;
    }
}

class DownloadManager {
    static downloadInProgress_static = false;
    constructor(DatabaseManager = null, SystemLogger = null, UpscaleManager = null) {
        log5("DownloadManager constructor called");
        log6("DownloadManager constructor\nDatabaseManager: " + DatabaseManager + "\nSystemLogger: " + SystemLogger + "\nUpscaleManager: " + UpscaleManager);
        this.upscaleManager = UpscaleManager;
        this.downloadLocation = "output";
        this.timeToDownload = 0; // minutes past midnight
        this.downloadRunEnabled = false;
        this.downloadInProgress = false;
        this.concurrentDownloads = 0;
        this.runTimeout = null;
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
        this.start();
        this.verifyDownloadsInProgress = false;
        this.downloadBrowser = null;
        this.downloadBrowserLaunchPromise = null;
        log6("DownloadManager constructor complete");
    }

    setDownloadLocation(location) {
        log5("DownloadManager.setDownloadLocation() called");
        log6("DownloadManager.setDownloadLocation()\nlocation: " + location);
        this.downloadLocation = location;
        let stats = fs.statSync(this.downloadLocation);
        if (!stats.isDirectory()) {
            log1("DownloadManager.setDownloadLocation() warning: Download location is not a directory. Download location: " + this.downloadLocation);
            return false;
        }
        try {
            if (!fs.existsSync(this.downloadLocation)) fs.mkdirSync(this.downloadLocation, { recursive: true });
        } catch (err) {
            log0(["DownloadManager.setDownloadLocation() error: Error creating download location directory", err]);
            return false;
        }
        return true;
    }

    setTimeToDownload(time) {
        log5("DownloadManager.setTimeToDownload() called");
        log6("DownloadManager.setTimeToDownload()\ntime: " + time);
        if (typeof time === "string") {
            try {
                time = parseInt(time);
            } catch {
                log0(["DownloadManager.setTimeToDownload() error: Error parsing time to download", time]);
                return false;
            }
        }
        if (typeof time !== "number") {
            log1("DownloadManager.setTimeToDownload(): Time to download is not a number. time: " + time);
            return false;
        }
        this.timeToDownload = time;
        if (this.timeToDownload < 0) this.timeToDownload = 0;
        if (this.timeToDownload > 1440) this.timeToDownload = this.timeToDownload % 1440;
        log6("DownloadManager.setTimeToDownload() complete");
        return true;
    }

    async downloadImage(url, image) {
        log5("DownloadManager.downloadImage() called");
        log6("DownloadManager.downloadImage()\nurl: " + url + "\nimage: " + JSON.stringify(image));
        let imageBuffer = null;
        let contentType = null;
        let contentLengthHeader = null;
        let usedBrowser = false;

        // Prefer Puppeteer (real browser stack) first
        try {
            const browserResult = await this.downloadImageWithBrowser(url);
            imageBuffer = browserResult.buffer;
            contentType = browserResult.headers["content-type"];
            contentLengthHeader = browserResult.headers["content-length"];
            usedBrowser = true;
        } catch (err) {
            log1(["DownloadManager.downloadImage() warning: Browser fetch failed, falling back to node fetch", err]);
        }

        // Fallback to node fetch if browser fetch failed
        if (!imageBuffer) {
            let response;
            try {
                const requestHeaders = {
                    accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "accept-language": "en-US,en;q=0.9",
                    "cache-control": "no-cache",
                    pragma: "no-cache",
                    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    referer: "https://www.midjourney.com/",
                    origin: "https://www.midjourney.com",
                    "accept-encoding": "identity",
                };
                response = await fetch(url, {
                    headers: requestHeaders,
                    body: null,
                    method: "GET",
                });
            } catch (err) {
                log0(["DownloadManager.downloadImage() error: Error downloading image", err, image]);
                return { success: false, error: err };
            }

            if (!response.ok) {
                log0(["DownloadManager.downloadImage() error: Bad response code", response.status, image]);
                return {
                    success: false,
                    error: "Bad response code: " + response.status,
                    status: response.status,
                };
            }
            contentType = response.headers.get("content-type");
            contentLengthHeader = response.headers.get("content-length");
            if (contentType && contentType !== "image/png") {
                log0(["DownloadManager.downloadImage() error: Bad content type", contentType, image]);
                return {
                    success: false,
                    error: "Bad content type: " + contentType,
                };
            }
            if (contentLengthHeader && parseInt(contentLengthHeader, 10) < 1000) {
                log0(["DownloadManager.downloadImage() error: Bad content length", contentLengthHeader, image]);
                return {
                    success: false,
                    error: "Bad content length: " + contentLengthHeader,
                };
            }
            imageBuffer = Buffer.from(await response.arrayBuffer());
        }

        if (!imageBuffer) {
            return {
                success: false,
                error: "No image data received from browser or fetch",
            };
        }

        log6("DownloadManager.downloadImage() Fetch successful");

        let contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : imageBuffer.length;
        log6("DownloadManager.downloadImage() contentLength: " + contentLength);
        let imageDate = new Date(image.enqueue_time);
        log6("DownloadManager.downloadImage() imageDate: " + imageDate);
        let year = imageDate.getFullYear();
        let month = imageDate.getMonth() + 1;
        let day = imageDate.getDate();
        let destFolder = this.downloadLocation + "/" + year + "/" + month + "/" + day;
        log6("DownloadManager.downloadImage() destFolder: " + destFolder);
        if (!fs.existsSync(destFolder)) {
            log1("DownloadManager.downloadImage() warning: Destination folder does not exist. Creating it now. Folder: " + destFolder);
            fs.mkdirSync(destFolder, { recursive: true });
        }
        const parsedImageUrl = new URL(url);
        const splitImage = parsedImageUrl.pathname.split("/").filter(Boolean);
        const destFileName = splitImage[splitImage.length - 2] + "-" + splitImage[splitImage.length - 1];
        log6("DownloadManager.downloadImage() destFileName: " + destFileName);

        if (fs.existsSync(path.join(destFolder, destFileName))) {
            // delete file
            log1("DownloadManager.downloadImage() warning: File already exists. Deleting it now. File: " + path.join(destFolder, destFileName));
            fs.unlinkSync(path.join(destFolder, destFileName));
        }
        fs.writeFileSync(path.join(destFolder, destFileName), imageBuffer);
        let fileSize = 0;
        // await waitSeconds(0.5);
        let file = fs.statSync(path.join(destFolder, destFileName));
        fileSize = file.size;
        fileSize = parseInt(fileSize);
        log6("DownloadManager.downloadImage() fileSize: " + fileSize);
        contentLength = parseInt(contentLength);
        if (fileSize != contentLength) {
            log0(["DownloadManager.downloadImage() error: File size mismatch: " + fileSize + " != " + contentLength + (usedBrowser ? " (browser used)" : ""), image]);
            return {
                success: false,
                error: "File size mismatch: " + fileSize + " != " + contentLength,
            };
            // return;
        }
        log4("Downloaded image " + destFileName + " of size " + fileSize + " bytes");
        image.downloaded = true;
        image.storageLocation = path.join(destFolder, destFileName);
        image.processed = true;
        image.fileSize = fileSize;
        image.success = true;
        log6("DownloadManager.downloadImage() complete");
        return image;
    }

    async downloadImageWithBrowser(url) {
        log5("DownloadManager.downloadImageWithBrowser() called");
        // Prefer the main puppeteerClient browser if it exists so we reuse cookies / stealth settings
        let browser = (puppeteerClient && puppeteerClient.browser) || this.downloadBrowser;
        if (!browser || !browser.isConnected()) {
            if (!this.downloadBrowserLaunchPromise) {
                log6("DownloadManager.downloadImageWithBrowser(): launching shared headless browser for downloads");
                this.downloadBrowserLaunchPromise = puppeteer.launch(puppeteerDiagnostics.launchOptions({
                    headless: "new",
                    args: ["--no-sandbox", "--disable-setuid-sandbox"],
                })).then((launchedBrowser) => {
                    puppeteerDiagnostics.attachBrowser(launchedBrowser);
                    this.downloadBrowser = launchedBrowser;
                    return launchedBrowser;
                }).finally(() => {
                    this.downloadBrowserLaunchPromise = null;
                });
            }
            browser = await this.downloadBrowserLaunchPromise;
        }
        const page = await browser.newPage();
        puppeteerDiagnostics.attachPage(page);
        try {
            try {
                const sessionData = JSON.parse(fs.readFileSync(MJ_SESSION_PATH, "utf8"));
                if (Array.isArray(sessionData.cookies) && sessionData.cookies.length) {
                    await page.setCookie(...sessionData.cookies);
                }
            } catch (err) {
                log1(["DownloadManager.downloadImageWithBrowser(): unable to load saved Midjourney cookies", err]);
            }
            const resp = await page.goto(url, { waitUntil: "networkidle2" });
            if (!resp || !resp.ok()) {
                throw new Error(`Browser fetch failed with status ${resp?.status?.()}`);
            }
            const buffer = await resp.buffer();
            const headers = resp.headers();
            return { buffer, headers };
        } finally {
            await page.close().catch(() => {});
        }
    }

    start() {
        log5("DownloadManager.start() called");
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        log6("now: " + now);
        let timeToDownload = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToDownload / 60, this.timeToDownload % 60, 0, 0);
        log6("timeToDownload: " + timeToDownload);
        let timeUntilDownload = timeToDownload - now;
        log6("timeUntilDownload: " + timeUntilDownload);
        if (timeUntilDownload < 0) timeUntilDownload += 1000 * 60 * 60 * 24;
        log6("timeUntilDownload: " + timeUntilDownload);
        this.runTimeout = setTimeout(() => this.run(), timeUntilDownload);
        log6("DownloadManager.start() complete");
    }

    async run() {
        log5("DownloadManager.run() called");
        if (!this.downloadRunEnabled) {
            log1("DownloadManager.run() warning: Run is disabled. Run will not start.");
            this.start();
            return;
        }
        if (this.verifyDownloadsInProgress) {
            log1("DownloadManager.run() warning: Verify downloads is in progress. Will try again in 10 seconds.");
            setTimeout(() => this.run(), 10000);
            return;
        }
        if (DatabaseUpdateManager.updateInProgress_static === true) {
            log1("DownloadManager.run() warning: Database update is in progress. Will try again in 5 minutes.");
            setTimeout(() => this.run(), 1000 * 60 * 5);
            return;
        }
        if (this.downloadInProgress === true) return;
        this.downloadInProgress = true;
        DownloadManager.downloadInProgress_static = true;
        log6("DownloadManager.run() downloadInProgress: " + this.downloadInProgress);
        log6("DownloadManager.run() Verifying downloads");
        await this.verifyDownloads();
        this.concurrentDownloads = 0;
        let success = true;
        let lastId = 0;
        let queuedCount = 0;
        while (this.downloadRunEnabled) {
            const images = await this.dbClient.getPendingDownloadsAfterId(lastId, DEFAULT_DOWNLOAD_BATCH_SIZE);
            if (images === null) {
                success = false;
                break;
            }
            if (images.length === 0) break;

            lastId = images[images.length - 1].id;
            queuedCount += images.length;
            if (!(await this.downloadPendingImages(images))) success = false;
        }
        log2(`Processed ${queuedCount} queued downloads`);
        if (success) {
            log2("Done downloading images");
        } else {
            log0("One or more errors occurred while downloading images");
            this.systemLogger?.log("One or more errors occurred while downloading images");
            DownloadError.sendErrorCountToSystemLogger();
            DownloadError.resetCount();
        }
        this.downloadInProgress = false;
        DownloadManager.downloadInProgress_static = false;
        this.start();
        log6("DownloadManager.run() complete");
    }

    async downloadPendingImages(images) {
        log5("DownloadManager.downloadPendingImages() called");
        if (!this.downloadRunEnabled) {
            log1("DownloadManager.downloadPendingImages() warning: Run is disabled. Run will not start.");
            return true;
        }
        const results = await runInConcurrentChunks(
            images,
            (image) => this.downloadPendingImage(image),
            DEFAULT_DOWNLOAD_CONCURRENCY
        );
        log6("DownloadManager.downloadPendingImages() complete");
        return results.every(Boolean);
    }

    async downloadPendingImage(imageRow) {
        const image = new ImageInfo(imageRow.parent_uuid, imageRow.grid_index, imageRow.enqueue_time, imageRow.full_command, imageRow.width, imageRow.height);
        this.concurrentDownloads++;
        try {
            // Older 4x upscales are recorded at their requested dimensions, but
            // Midjourney now serves them through its capped 2048px JPEG URL.
            // Try that URL first so a CDN 403 on the obsolete original URL does
            // not prevent the valid legacy asset from being downloaded.
            const isLegacyLargeUpscale = Number(image.width) > 2048 || Number(image.height) > 2048;
            const candidateUrls = [...new Set(isLegacyLargeUpscale
                ? [image.urlLargeJpeg, image.urlJpeg, image.urlFull, image.urlAlt]
                : [image.urlJpeg, image.urlFull, image.urlAlt])];
            const failures = [];
            const attempts = DOWNLOAD_RETRY_DELAYS_SECONDS.length + 1;
            for (let attempt = 0; attempt < attempts; attempt++) {
                let throttled = false;
                for (const url of candidateUrls) {
                    const imageResult = await this.downloadImage(url, image);
                    if (imageResult.success === true) {
                        const updateResult = await this.dbClient.updateImage(imageResult);
                        return updateResult !== null && updateResult.rowCount === 1;
                    }
                    failures.push(`attempt ${attempt + 1} ${url}: ${imageResult.error}`);
                    if (imageResult.status === 403 || imageResult.status === 429) {
                        throttled = true;
                        break;
                    }
                }
                if (attempt < DOWNLOAD_RETRY_DELAYS_SECONDS.length) {
                    if (throttled) log1(`Midjourney CDN throttled ${image.id}; retrying after ${DOWNLOAD_RETRY_DELAYS_SECONDS[attempt]} seconds`);
                    await waitSeconds(DOWNLOAD_RETRY_DELAYS_SECONDS[attempt]);
                }
            }

            const error = failures.join("; ");
            log0(["DownloadManager.downloadPendingImage() error: All image URLs failed", error, image]);
            this.systemLogger?.log(`Unable to download image ${image.id}: all ${candidateUrls.length} URL forms failed`);
            new DownloadError("All image URLs failed", error, image);
            return false;
        } catch (err) {
            log0(["DownloadManager.downloadPendingImage() error: Error downloading image", err, image]);
            new DownloadError("Error downloading image", err, image);
            return false;
        } finally {
            this.concurrentDownloads--;
        }
    }

    async verifyDownloads() {
        log5("DownloadManager.verifyDownloads() called");
        if (this.verifyDownloadsInProgress) {
            log2("DownloadManager.verifyDownloads() warning: Verify downloads is already in progress. Will not start another.");
            return;
        }
        this.verifyDownloadsInProgress = true;
        const startedAt = performance.now();
        try {
            const downloads = await this.dbClient.getDownloadedFileReferences();
            if (downloads === null) throw new Error("Unable to load downloaded file references");

            log2(`Verifying ${downloads.length} downloaded files`);
            const missingIds = await findMissingDownloadIds(downloads);
            const updated = await this.dbClient.markDownloadsMissing(missingIds);
            if (updated === null) throw new Error("Unable to update missing downloads");

            const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);
            log2(`Verified ${downloads.length} downloaded files in ${elapsedSeconds}s; ${updated} missing files queued for download`);
            return { checked: downloads.length, missing: updated };
        } catch (error) {
            log0(["DownloadManager.verifyDownloads() error", error]);
            this.systemLogger?.log("Unable to verify downloaded files: " + error.message);
            return null;
        } finally {
            this.verifyDownloadsInProgress = false;
            log6("DownloadManager.verifyDownloads() complete");
        }
    }
}

class UpscaleManager {
    constructor(DatabaseManager = null, SystemLogger = null) {
        log5("UpscaleManager constructor called");
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
        this.queue = [];
        this.upscaler = new Upscaler({
            defaultScale: 4, // can be 2, 3, or 4
            defaultFormat: "jpg", // or "png"
            downloadProgressCallback: () => {}, // Callback that gets called twice per second while a download is in progress
            defaultModel: "ultrasharp-2.0.1", // Default model name
            maxJobs: 2, // Max # of concurrent jobs
        });
        this.timeToUpscale = 0; // minutes past midnight
        this.runEnabled = false;
        this.runTimeout = null;
        this.upscaleRunInprogress = false;
        this.start();
    }

    start() {
        log5("UpscaleManager.start() called");
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        let timeToUpscale = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToUpscale / 60, this.timeToUpscale % 60, 0, 0);
        let timeUntilUpscale = timeToUpscale - now;
        if (timeUntilUpscale < 0) timeUntilUpscale += 1000 * 60 * 60 * 24;
        this.runTimeout = setTimeout(() => this.run(), timeUntilUpscale);
    }

    async run() {
        log5("UpscaleManager.run() called");
        if (!this.runEnabled) {
            log1("UpscaleManager.run() warning: Run is disabled. Run will not start.");
            this.start();
            return;
        }

        if (this.upscaleRunInprogress) return;
        this.queue = [];
        this.upscaleRunInprogress = true;
        let imageCount = await this.dbClient.countImagesTotal();
        log2("Image count: " + imageCount);
        let success = true;
        for (let i = 0; i < imageCount; i++) {
            if (!(await this.lookupAndUpscaleImageByIndex(i))) success = false;
        }
        if (success) {
            log2("Done upscaling images");
        } else {
            log0("One or more errors occurred while upscaling images");
            this.systemLogger?.log("One or more errors occurred while upscaling images");
        }
        this.checkForFinishedJobs();
        this.start();
    }

    async lookupAndUpscaleImageByIndex(index) {
        log5("UpscaleManager.lookupAndUpscaleImageByIndex() called");
        if (!this.runEnabled) {
            log1("UpscaleManager.lookupAndUpscaleImageByIndex() warning: Run is disabled.");
            return true;
        }
        let image = await this.dbClient.lookupImageByIndex(index, { processed: true, enabled: true }, { downloaded: true, enabled: true }, { do_not_download: false, enabled: true });
        if (image === undefined) return true;
        if (image === null) return true;
        // image = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height, image.storage_location);
        this.queueImage(image);
    }

    queueImage(image) {
        log5("UpscaleManager.queueImage() called");
        // console.log("Upscailing image");
        // get folder name from image.storageLocation
        if (image.storage_location.includes("\\")) image.storage_location = image.storage_location.replaceAll("\\", "/");
        let folder = image.storage_location.substring(0, image.storage_location.lastIndexOf("/"));
        // console.log("folder: " + folder);
        let destFolder = path.join(folder, "upscaled");
        // console.log("destFolder: " + destFolder);
        if (!fs.existsSync(destFolder)) {
            log1("UpscaleManager.queueImage() warning: Destination folder does not exist. Creating it now. Folder: " + destFolder);
            // console.log("Creating folder: " + destFolder);
            fs.mkdirSync(destFolder, { recursive: true });
        }
        let destFileName = image.storage_location.split("/").pop();
        // console.log("destFileName: " + destFileName);
        destFileName = destFileName.substring(0, destFileName.lastIndexOf(".")) + "-upscaled.jpg";
        // console.log("destFileName: " + destFileName);
        image.upscale_location = path.join(destFolder, destFileName);
        // console.log("image.upscale_location: " + image.upscale_location);
        this.upscaler.upscale(image.storage_location.replaceAll("\\", "/").replaceAll("\\\\", "/"), destFolder.replaceAll("\\", "/").replaceAll("\\\\", "/")).then((jobID) => {
            image.jobID = jobID;
            this.queue.push(image);
            log6(["Queued image ", image]);
        });
    }

    async checkForFinishedJobs() {
        log5("UpscaleManager.checkForFinishedJobs() called");
        if (this.queue.length === 0) {
            this.upscaleRunInprogress = false;
            return;
        }
        let finishedJobs = this.queue.filter((img) => {
            let jobID = img.jobID;
            if (jobID === null) return false;
            let job = this.upscaler.getJob(jobID);
            if (job === null) return false;
            if (job.status == "complete") return true;
            else return false;
        });
        (() => {
            finishedJobs.forEach(async (image) => {
                image.id = image.uuid;
                log2("Finished job: ", image.jobID);
                log4("Image: ", image);
                // TODO: verify file exists and is valid jpg
                await this.dbClient.updateImage(image);
                this.queue = this.queue.filter((image2) => {
                    return image2.jobID !== image.jobID;
                });
            });
        })();

        await waitSeconds(120);
        this.checkForFinishedJobs();
    }

    async stopRunningJobs() {
        log5("UpscaleManager.stopRunningJobs() called");
        let runningJobs = this.queue.filter((img) => {
            let jobID = img.jobID;
            if (jobID === null) return false;
            let job = this.upscaler.getJob(jobID);
            if (job === null) return false;
            if (job.status == "complete") return false;
            else return true;
        });
        (() => {
            runningJobs.forEach(async (image) => {
                image.id = image.uuid;
                log2("Stopping job: ", image.jobID);

                let jobID = image.jobID;
                if (jobID === null) return;
                let job = this.upscaler.getJob(jobID);
                if (job === null) return;
                else {
                    this.upscaler.cancelJob(jobID);
                }
            });
        })();
        log6("UpscaleManager.stopRunningJobs() complete");
    }

    get queuedUpscales() {
        log5("UpscaleManager.get queuedUpscales() called");
        return this.upscaler.getNumberOfWaitingJobs();
    }

    get runningUpscales() {
        log5("UpscaleManager.get runningUpscales() called");
        return this.upscaler.getNumberOfRunningJobs();
    }

    get upscaleInProgress() {
        log5("UpscaleManager.get upscaleInProgress() called");
        return this.upscaler.getNumberOfRunningJobs() > 0;
    }
}

const puppeteerClient = new PuppeteerClient();
const imageDB = new Database();
const upscalerManager = new UpscaleManager(imageDB, systemLogger);
const downloadManager = new DownloadManager(imageDB, systemLogger, upscalerManager);

(async () => {
    if (!verifyDownloadsOnStartup) return;
    log6("Verifying downloads on startup");
    log6("Waiting for database to connect");
    while (Database.DB_connected === false) {
        await waitSeconds(1);
    }
    log6("Database connected");
    log2("Verifying downloads");
    await downloadManager.verifyDownloads();
    log2("Done verifying downloads");
})();

const databaseUpdateManager = new DatabaseUpdateManager(imageDB, systemLogger, puppeteerClient);
const databaseUpdateManualData = new DatabaseUpdateManualData(imageDB, systemLogger);
const serverStatusMonitor = new ServerStatusMonitor(systemLogger, puppeteerClient, downloadManager, imageDB, upscalerManager, databaseUpdateManager);

try {
    settings = loadSettingsFile(SETTINGS_PATH);
} catch (error) {
    log0("Error loading settings file", error);
    settings = null;
}
if (!settings) {
    log1("Settings file not found. Using default settings", new Date().toLocaleString());
    settings = {
        downloadLocation: "output",
        timeToDownload: 0,
        downloadRunEnabled: false,
        dbUpdateRunEnabled: false,
        upscaleRunEnabled: false,
        updateDB: true,
    };
}
downloadManager?.setDownloadLocation(settings.downloadLocation);
downloadManager?.setTimeToDownload(settings.timeToDownload);

downloadManager.downloadRunEnabled = settings.downloadRunEnabled;
databaseUpdateManager.runEnabled = settings.dbUpdateRunEnabled;
upscalerManager.runEnabled = settings.upscaleRunEnabled;

updateDB = settings.updateDB;

/////////////////////////////////////////////////////////////////////////////////////////
app.use(express.static("public"));
app.use(express.static(PROJECT_ROOT));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Start the server on port 3000 and print all the ip addresses of this server
app.listen(port, () => {
    log3("Server listening on port " + port);
    // get this server's ip address
    const os = require("os");
    const ifaces = os.networkInterfaces();
    let ipAddresses = [];
    Object.keys(ifaces).forEach(function (ifname) {
        let alias = 0;
        ifaces[ifname].forEach(function (iface) {
            if ("IPv4" !== iface.family || iface.internal !== false) return;
            if (alias >= 1) ipAddresses.push(iface.address);
            else ipAddresses.push(iface.address);
            ++alias;
        });
    });
    ipAddresses.forEach((ip) => {
        log2(`Server running at http://${ip}:${port}/`);
    });
});

app.set("view engine", "ejs");
app.set("views", path.join(PROJECT_ROOT, "views"));

/****************************************************************************************
 * Server endpoints
 */
/**
 * GET /
 * Home page
 */
registerRoutes({
    app,
    projectRoot: PROJECT_ROOT,
    databaseUpdateManager,
    databaseUpdateManualData,
    imageDB,
    ImageInfo,
    downloadManager,
    upscalerManager,
    settings,
    systemLogger,
    serverStatusMonitor,
    saveSettings: persistSettings,
    log2,
    log3,
    log4,
    log6,
});

////////////////////////////////////////////////////////////////////////////////////////
/////  Utilities
////////////////////////////////////////////////////////////////////////////////////////


const buildImageData = (data, options = {}) => buildMidjourneyImageData(data, { debug: log5, trace: log6, ...options });


function persistSettings() {
    log5("persistSettings() called");
    saveSettingsFile(SETTINGS_PATH, settings);
    log2("Setting saved", new Date().toLocaleString());
}

log2("Server started", new Date().toLocaleString());

process.on("exit", (code) => {
    persistSettings();
    log2("exiting");
    imageDB.dbClient.end();
    log2("Server exited", new Date().toLocaleString());
});
