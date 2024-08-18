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
const express = require("express");
const bodyParser = require("body-parser");
const sharp = require("sharp");
const PNG = require("pngjs").PNG;
const app = express();
const port = process.env.mj_dl_server_port | 3000;
app.use(bodyParser.json({ limit: "100mb" }));
const pgClient = require("pg");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const Upscaler = require("ai-upscale-module");
const winston = require("winston");
require("winston-daily-rotate-file");
const Transport = require("winston-transport");
const util = require("util");
const { spawn } = require("child_process");
var removeRoute = require("express-remove-route");

let logLevel = process.env.mj_dl_server_log_level ?? 0;
if (typeof logLevel === "string") logLevel = parseInt(logLevel);
let updateDB = process.env.mj_dl_server_updateDB ?? true;
if (typeof updateDB === "string") updateDB = updateDB === "true";
let verifyDownloadsOnStartup =
    process.env.mj_dl_server_verifyDlOnStartup ?? true;
if (typeof verifyDownloadsOnStartup === "string")
    verifyDownloadsOnStartup = verifyDownloadsOnStartup === "true";

let settings = {};

const log_levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6,
};
const log_level_names = Object.keys(log_levels);

const logFileTransport = new winston.transports.DailyRotateFile({
    filename: "log/%DATE%.log",
    datePattern: "YYYY-MM-DD",
    maxSize: "10m",
    maxFiles: "1d",
});

const winstonLogger = winston.createLogger({
    level: log_level_names[logLevel],
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(
            (info) => `${info.timestamp} ${info.level}: ${info.message}`
        )
    ),
    transports: [new winston.transports.Console(), logFileTransport],
});

winstonLogger[log_level_names[logLevel]](["Server Starting..."]);
winstonLogger[log_level_names[logLevel]]([
    "Log level set to " + log_level_names[logLevel],
]);
winstonLogger[log_level_names[logLevel]](["Update DB set to " + updateDB]);
winstonLogger[log_level_names[logLevel]]([
    "Verify Downloads on Startup set to " + verifyDownloadsOnStartup,
]);

const logX_to_winston = (x, ...args) => {
    if (args.every((arg) => typeof arg === "string")) {
        winstonLogger[log_level_names[x]](args.join(" "));
    } else {
        winstonLogger[log_level_names[x]](JSON.stringify(args, null, 2));
    }
};

/**
 * @var {function} log0 - Alias for winstonLogger.error()
 */
let log0 = (...args) => {
    logX_to_winston(0, ...args);
};
/**
 * @var {function} log1 - Alias for winstonLogger.warn()
 */
let log1 = (...args) => {
    logX_to_winston(1, ...args);
};
/**
 * @var {function} log2 - Alias for winstonLogger.info()
 */
let log2 = (...args) => {
    logX_to_winston(2, ...args);
};
/**
 * @var {function} log3 - Alias for winstonLogger.http()
 */
let log3 = (...args) => {
    logX_to_winston(3, ...args);
};
/**
 * @var {function} log4 - Alias for winstonLogger.verbose()
 */
let log4 = (...args) => {
    logX_to_winston(4, ...args);
};
/**
 * @var {function} log5 - Alias for winstonLogger.debug()
 */
let log5 = (...args) => {
    logX_to_winston(5, ...args);
};
/**
 * @var {function} log6 - Alias for winstonLogger.silly()
 */
let log6 = (...args) => {
    logX_to_winston(6, ...args);
};

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
        log5(
            "Reset downloadError.count. New DownloadError count: " +
                DownloadError.count
        );
    }

    static sendErrorCountToSystemLogger() {
        systemLogger?.log(
            "DownloadError!!! ",
            "DownloadError count: " + DownloadError.count
        );
        log5("Added DownloadError count to systemLogger");
    }
}

class SystemLogger {
    constructor() {
        log5("SystemLogger constructor called");
        this.logArr = [];
        this.idIndex = 0;
    }

    log(...message) {
        log5("systemLogger.log called with message: " + message.join(" : "));
        winstonLogger?.log("error", message.join(" : "));
        let entry = {};
        entry.time = new Date();
        entry.message = message;
        entry.id = this.idIndex++;
        log6("systemLogger.log entry: " + JSON.stringify(entry));
        this.logArr.push(entry);
    }

    getLog() {
        log5("systemLogger.getLog called");
        return this.logArr;
    }

    clearLog() {
        this.logArr = [];
        log5("Cleared systemLogger log");
    }

    printLog() {
        log5("systemLogger.printLog called");
        console.log(this.logArr);
    }

    getMostRecentLog(remove = false) {
        log5("systemLogger.getMostRecentLog called with remove = " + remove);
        if (this.logArr.length === 0) return null;
        log6(
            "systemLogger.getMostRecentLog logArr: " +
                JSON.stringify(this.logArr)
        );
        let logTemp = this.logArr[this.logArr.length - 1];
        if (remove) {
            this.logArr.pop();
        }
        log6(
            "systemLogger.getMostRecentLog logTemp: " + JSON.stringify(logTemp)
        );
        return logTemp;
    }

    getRecentEntries(numberOfEntries, remove = false) {
        log5(
            "systemLogger.getRecentEntries called with numberOfEntries = " +
                numberOfEntries +
                " and remove = " +
                remove
        );
        let entries = [];
        if (typeof numberOfEntries === "string")
            numberOfEntries = parseInt(numberOfEntries);
        numberOfEntries = Math.min(numberOfEntries, this.logArr.length);
        log6(
            "systemLogger.getRecentEntries numberOfEntries = " + numberOfEntries
        );
        if (remove) {
            log1("Removing " + numberOfEntries + " entries from systemLogger");
            for (let i = 0; i < numberOfEntries; i++) {
                entries.push(this.getMostRecentLog(remove));
            }
        } else {
            for (let i = 0; i < numberOfEntries; i++) {
                entries.push(this.logArr[this.logArr.length - 1 - i]);
            }
        }
        log6(
            "systemLogger.getRecentEntries entries = " + JSON.stringify(entries)
        );
        return entries;
    }

    deleteEntry(id) {
        log5("systemLogger.deleteEntry called with id = " + id);
        if (typeof id === "string") id = parseInt(id);
        for (let i = 0; i < this.logArr.length; i++) {
            if (this.logArr[i].id === id) {
                this.logArr.splice(i, 1);
                log6("systemLogger.deleteEntry deleted entry with id = " + id);
                return true;
            }
        }
        log6("systemLogger.deleteEntry did not find entry with id = " + id);
        return false;
    }

    getNumberOfEntries() {
        log5("systemLogger.getNumberOfEntries called");
        return this.logArr.length;
    }
}

const systemLogger = new SystemLogger();

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
        this.discord_cookies = null;
        this.discord_localStorage = null;
        this.discord_sessionStorage = null;
        this.discordLoginComplete = false;
        this.googleLoginComplete = false;
    }

    /**
     * Loads the session data from the session files and attempts to restore the session.
     * @returns {Promise<void>} - nothing
     */
    async loadSession() {
        log5("loadSession() called");
        return new Promise(async (resolve, reject) => {
            if (
                fs.existsSync("mjSession.json") &&
                fs.existsSync("discordSession.json")
            ) {
                log6("Session files found. Loading session data.");
                let sessionData = JSON.parse(fs.readFileSync("mjSession.json"));
                this.mj_cookies = sessionData.cookies;
                this.mj_localStorage = sessionData.localStorage;
                this.mj_sessionStorage = sessionData.sessionStorage;
                sessionData = JSON.parse(
                    fs.readFileSync("discordSession.json")
                );
                this.discord_cookies = sessionData.cookies;
                this.discord_localStorage = sessionData.localStorage;
                this.discord_sessionStorage = sessionData.sessionStorage;
                log6("Session data loaded.");
            } else {
                log0("LoadSession error. Session file not found.");
                reject("Session file not found");
                return;
            }

            if (this.browser == null) {
                log1("Browser is null. Launching new browser.");
                this.browser = await puppeteer.launch({
                    headless: false,
                    defaultViewport: null,
                    args: ["--enable-javascript"],
                });
                log6("Browser launched.");
                this.browser.on("disconnected", () => {
                    log6(
                        "Browser disconnected. Setting browser and page to null. Setting loggedIntoMJ to false. Setting loginInProgress to false. Killing all chrome processes."
                    );
                    this.browser = null;
                    this.page = null;
                    this.loggedIntoMJ = false;
                    this.loginInProgress = false;
                    spawn("killall", ["chrome"]);
                });
                this.page = (await this.browser.pages())[0];
                log6("Page set.");
            }

            log6("Setting cookies.");
            await this.page.goto("https://www.midjourney.com/imagine", {
                waitUntil: "networkidle2",
                timeout: 60000,
            });
            let discordPage = await this.browser.newPage();
            await discordPage.goto("https://discord.com/");
            await waitSeconds(1);
            await this.page.setCookie(...this.mj_cookies);
            await discordPage.setCookie(...this.discord_cookies);
            await waitSeconds(1);
            log6("Cookies set.");
            log6("Closing discord page.");
            await discordPage?.close();
            log6("Discord page closed.");

            log6("Navigating to MJ home page.");
            await this.page.goto("https://www.midjourney.com/imagine", {
                waitUntil: "networkidle2",
                timeout: 60000,
            });
            await waitSeconds(2);
            if (
                this.page.url().includes("https://www.midjourney.com/imagine")
            ) {
                log6("Successfully navigated to MJ home page.");
                log6("Session restore successful.");
                this.loggedIntoMJ = true;
                resolve();
            } else {
                log6("Session restore failed.");
                this.loggedIntoMJ = false;
                log0("loadSession() error. Session restore failed.");
                reject("Session restore failed");
            }
            log6("loadSession() complete.");
        });
    }

    /**
     * Attempts to log into Midjourney. If the user is not logged in, it will attempt to log in using the credentials_cb function.
     * @param {CallableFunction} credentials_cb function to call to get login credentials
     * @returns {Promise<void>} - nothing
     */
    async loginToMJ(credentials_cb) {
        log5("loginToMJ() called");
        return new Promise(async (resolve, reject) => {
            if (
                (!this.loggedIntoMJ || this.browser == null) &&
                !this.loginInProgress
            ) {
                log6(
                    "Not logged into MJ and not currently logging in. Attempting to restore session."
                );
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
                        this.browser = await puppeteer.launch({
                            headless: false,
                            defaultViewport: null,
                            args: ["--enable-javascript"],
                        });
                        log6("Browser launched.");
                        this.page = (await this.browser.pages())[0];
                        log6("Page set.");

                        log6(
                            "Setting up targetcreated event listener for discord.com/login."
                        );
                        this.browser.on("targetcreated", async (target) => {
                            log6(
                                "Target created. Checking if target is discord.com/login."
                            );
                            const pageList = await this.browser.pages();
                            let discordLoginPage =
                                pageList[pageList.length - 1];
                            if (
                                discordLoginPage
                                    .url()
                                    .includes("discord.com/login")
                            ) {
                                log6(
                                    "Target is discord.com/login. Logging into Discord."
                                );
                                await this.loginToDiscord(
                                    discordLoginPage,
                                    credentials_cb
                                );
                            }
                            let googleLoginPage = pageList[pageList.length - 1];
                            if (
                                googleLoginPage
                                    .url()
                                    .includes("accounts.google.com")
                            ) {
                                log6(
                                    "Target is accounts.google.com. Logging into Google."
                                );
                                await this.loginToGoogle(
                                    googleLoginPage,
                                    credentials_cb
                                );
                            }
                        });
                        this.browser.on("disconnected", () => {
                            log6(
                                "Browser disconnected. Setting browser and page to null. Setting loggedIntoMJ to false. Setting loginInProgress to false. Killing all chrome processes."
                            );
                            this.browser = null;
                            this.page = null;
                            this.loggedIntoMJ = false;
                            this.loginInProgress = false;
                            spawn("killall", ["chrome"]);
                        });

                        log6("Navigating to MJ home page.");
                        await this.page.goto("https://www.midjourney.com/", {
                            waitUntil: "networkidle2",
                            timeout: 60000,
                        });
                        log6("Navigated to MJ home page.");
                        // let html = await this.page.content();
                        await waitSeconds(5);
                        log6(
                            "Moving mouse to (0,0) and then to (100,100) to make sure the 'Sign In' button appears."
                        );
                        await this.page.mouse.move(0, 0);
                        await this.page.mouse.move(100, 100);
                        await this.page.mouse.wheel({ deltaY: 100 });
                        await waitSeconds(1);
                        await this.page.mouse.wheel({ deltaY: -200 });
                        await waitSeconds(1);
                        log6("Clicking 'Log In' button.");
                        await this.page
                            .click("span ::-p-text(Log In)")
                            .catch(() => {
                                log0(
                                    "loginToMJ() error. Log In button not found."
                                );
                                reject("Log In button not found");
                            });
                        await waitSeconds(1);
                        await this.page
                            .click("div ::-p-text(Continue with Google)")
                            .catch(() => {
                                log0(
                                    "loginToMJ() error. Continue with Google button not found."
                                );
                                reject("Continue with Google button not found");
                            });
                        let waitCount = 0;
                        while (!this.discordLoginComplete && !this.googleLoginComplete) {
                            await waitSeconds(1);
                            waitCount++;
                            if (waitCount > 60 * 5) {
                                log0(
                                    "loginToMJ() error. Timed out waiting for login."
                                );
                                reject("Timed out waiting for login");
                                return;
                            }
                        }
                        await waitSeconds(5);
                        log6("Login process complete or failed.");
                        this.loginInProgress = false;
                        log6("Navigating to MJ home page.");
                        // await this.page.goto('https://www.midjourney.com/explore?tab=hot', { waitUntil: 'networkidle2', timeout: 60000 });
                        await waitSeconds(5);
                        log6("Navigated to MJ home page.");
                        log6(
                            "Checking to see if login was successful by checking the URL."
                        );
                        this.pageURL = this.page.url();
                        if (
                            this.pageURL.includes(
                                "https://www.midjourney.com/imagine"
                            ) ||
                            this.pageURL.includes(
                                "https://www.midjourney.com/explore"
                            )
                        ) {
                            log6("Login successful.");
                            this.loggedIntoMJ = true;
                            log6(
                                "Getting/saving cookies and local/session storage."
                            );
                            this.mj_cookies = await this.page.cookies();
                            this.mj_localStorage = await this.page.evaluate(
                                () => {
                                    return window.localStorage;
                                }
                            );
                            this.mj_sessionStorage = await this.page.evaluate(
                                () => {
                                    return window.sessionStorage;
                                }
                            );
                            try {
                                log6("Writing mjSession.json file.");
                                fs.writeFileSync(
                                    "mjSession.json",
                                    JSON.stringify({
                                        cookies: this.mj_cookies,
                                        localStorage: this.mj_localStorage,
                                        sessionStorage: this.mj_sessionStorage,
                                    })
                                );
                            } catch (err) {
                                log0(
                                    "Error writing mjSession.json file. Error: " +
                                        err
                                );
                            }

                            log6(
                                "Navigating to discord.com/channels/@me to get discord cookies and local/session storage."
                            );
                            let discordPage = await this.browser.newPage();
                            await discordPage.goto(
                                "https://discord.com/channels/@me"
                            );
                            await waitSeconds(2);
                            log6(
                                "Getting/saving cookies and local/session storage."
                            );
                            this.discord_cookies = await discordPage.cookies();
                            this.discord_localStorage =
                                await discordPage.evaluate(() => {
                                    return window.localStorage;
                                });
                            this.discord_sessionStorage =
                                await discordPage.evaluate(() => {
                                    return window.sessionStorage;
                                });
                            try {
                                log6("Writing discordSession.json file.");
                                fs.writeFileSync(
                                    "discordSession.json",
                                    JSON.stringify({
                                        cookies: this.discord_cookies,
                                        localStorage: this.discord_localStorage,
                                        sessionStorage:
                                            this.discord_sessionStorage,
                                    })
                                );
                            } catch (err) {
                                log0(
                                    "Error writing discordSession.json file. Error: " +
                                        err
                                );
                            }
                            await waitSeconds(15);
                            log6("Closing discord page.");
                            await discordPage?.close();
                            resolve();
                        } else {
                            this.loggedIntoMJ = false;
                            log0("loginToMJ() error. Login failed.");
                            reject("Login failed");
                        }
                    });
                if (this.loggedIntoMJ) {
                    log2("Already logged into MJ");
                    await this.page.goto("https://www.midjourney.com/imagine", {
                        waitUntil: "networkidle2",
                        timeout: 60000,
                    });
                    resolve();
                }
            }
        });
    }

    async loginToGoogle(googleLoginPage, credentials_cb) {
        log5("loginToGoogle() called");
        let credentials = await credentials_cb();
        console.log({credentials});
        let username = credentials.uName;
        let password = credentials.pWord;
        if (username === "" || password === "") {
            log1("loginToGoogle() error. Username or password is empty.");
            this.googleLoginComplete = false;
            return;
        }
        log6(
            "Logging into Google with username: " +
                username +
                " and password: " +
                password
        );
        await waitSeconds(2);
        log6("Typing username and password.");
        await googleLoginPage.waitForSelector('input[type="email"]');
        let typingRandomTimeMin = 0.03;
        let typingRandomTimeMax = 0.15;
        for (let i = 0; i < username.length; i++) {
            await googleLoginPage.type(
                'input[type="email"]',
                username.charAt(i)
            );
            let randomTime =
                Math.random() * typingRandomTimeMin + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }
        await googleLoginPage.keyboard.press("Enter");
        await waitSeconds(10);
        await googleLoginPage.waitForSelector('input[type="password"]');
        await waitSeconds(2);
        await googleLoginPage.click('input[type="password"]');
        for (let i = 0; i < password.length; i++) {
            await googleLoginPage.type(
                'input[type="password"]',
                password.charAt(i)
            );
            let randomTime =
                Math.random() * typingRandomTimeMin + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }
        log6("Username and password typed.");
        await waitSeconds(1);
        await googleLoginPage.keyboard.press("Enter");
        await waitSeconds(10);
        this.googleLoginComplete = true;
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
        log6(
            "Logging into Discord with username: " +
                username +
                " and password: " +
                password
        );
        let MFA_cb = credentials.mfaCb;
        await waitSeconds(1);
        log6("Typing username and password.");
        await discordLoginPage.waitForSelector('input[name="email"]');
        let typingRandomTimeMin = 0.03;
        let typingRandomTimeMax = 0.15;
        for (let i = 0; i < username.length; i++) {
            await discordLoginPage.type(
                'input[name="email"]',
                username.charAt(i)
            );
            let randomTime =
                Math.random() * typingRandomTimeMin + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }
        await discordLoginPage.keyboard.press("Tab");
        for (let i = 0; i < password.length; i++) {
            await discordLoginPage.type(
                'input[name="password"]',
                password.charAt(i)
            );
            let randomTime =
                Math.random() * typingRandomTimeMin + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }
        log6("Username and password typed.");
        await waitSeconds(1);
        log6("Clicking login button.");
        await discordLoginPage.click('button[type="submit"]');
        log6("Login button clicked. Waiting for MFA code input field");
        discordLoginPage
            .waitForSelector(
                'input[placeholder="6-digit authentication code"]',
                { timeout: 60000 }
            )
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
                await discordLoginPage.type(
                    'input[placeholder="6-digit authentication code"]',
                    data.toString()
                );
                log6("MFA code typed.");
                log6("Clicking submit button.");
                await discordLoginPage.click('button[type="submit"]');
                await waitSeconds(3);
                log6("Submit button clicked.");
                log6("Waiting for authorize button.");
                await discordLoginPage.waitForSelector(
                    "button ::-p-text(Authorize)",
                    { timeout: 60000 }
                );
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
            spawn("killall", ["chrome"]);
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
                    systemLogger.log(
                        "Not logged into MJ. Please send login credentials."
                    );
                    let uName = "";
                    let pWord = "";
                    let mfaCb = null;
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
                        if(password.includes("%23")) password = password.replace("%23", "#");
                        log6(
                            "Username: " + username + " Password: " + password
                        );
                        uName = username;
                        pWord = password;
                        mfaCb = async () => {
                            systemLogger.log(
                                "MFA code requested. Please send MFA code."
                            );
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
                                    log1(
                                        "getUsersJobsData(): Timed out waiting for MFA code."
                                    );
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
                            log1(
                                "getUsersJobsData(): Timed out waiting for login credentials."
                            );
                            break;
                        }
                        await waitSeconds(1);
                    }
                    return { uName, pWord, mfaCb };
                };
                await this.loginToMJ(uNamePWordCb).catch((err) => {
                    log0(
                        "getUsersJobsData() error. Not logged into MJ. Error: " +
                            err
                    );
                    reject("Not logged into MJ. Error: " + err);
                });
            }
            let waitCount = 0;
            while (this.loginInProgress) {
                await waitSeconds(1);
                waitCount++;
                if (waitCount > 60 * 5) {
                    log0(
                        "getUsersJobsData() error. Login in progress for too long"
                    );
                    reject("Login in progress for too long");
                }
            }
            await waitSeconds(2);
            let dataTemp = {};
            this.page
                ?.goto("https://www.midjourney.com/imagine", {
                    waitUntil: "networkidle2",
                    timeout: 60000,
                })
                .then(async () => {
                    log6("Navigated to MJ home page.");
                    if (!this.loggedIntoMJ) reject("Not logged into MJ");
                    log6("Getting user's jobs data.");
                    let data = await this.page.evaluate(async () => {
                        const getUserUUID = async () => {
                            let homePage = await fetch(
                                "https://www.midjourney.com/imagine"
                            );
                            let homePageText = await homePage.text();
                            let nextDataIndex =
                                homePageText.indexOf("__NEXT_DATA__");
                            let nextData =
                                homePageText.substring(nextDataIndex);
                            let startOfScript = nextData.indexOf('json">');
                            let endOfScript = nextData.indexOf("</script>");
                            let script = nextData.substring(
                                startOfScript + 6,
                                endOfScript
                            );
                            let json = script.substring(
                                script.indexOf("{"),
                                script.lastIndexOf("}") + 1
                            );
                            let data = JSON.parse(json);
                            imagineProps = data.props;
                            let userUUID =
                                data.props.initialAuthUser.midjourney_id;
                            return userUUID;
                        };
                        let userUUID = await getUserUUID();
                        let numberOfJobsReturned = 0;
                        let cursor = "";
                        let loopCount = 0;
                        let returnedData = [];
                        do {
                            // let response = await fetch("https://www.midjourney.com/api/pg/thomas-jobs?user_id=" + userUUID + "&page_size=10000" + (cursor == "" ? "" : "&cursor=" + cursor));
                            
                            // read all cookies
                            let cookies = document.cookie;

                            let response = await fetch(
                                "https://www.midjourney.com/api/pg/thomas-jobs?user_id=" +
                                    userUUID +
                                    "&page_size=10000" +
                                    (cursor == "" ? "" : "&cursor=" + cursor),
                                {
                                    headers: {
                                        accept: "*/*",
                                        "accept-language": "en-US,en;q=0.9",
                                        "cache-control": "no-cache",
                                        "content-type": "application/json",
                                        pragma: "no-cache",
                                        "sec-ch-ua":
                                            '"Chromium";v="118", "Google Chrome";v="118", "Not=A?Brand";v="99"',
                                        "sec-ch-ua-mobile": "?0",
                                        "sec-ch-ua-platform": '"Windows"',
                                        "sec-fetch-dest": "empty",
                                        "sec-fetch-mode": "cors",
                                        "sec-fetch-site": "same-origin",
                                        "x-csrf-protection": "1",
                                    },
                                    referrer:
                                        "https://www.midjourney.com/imagine",
                                    referrerPolicy: "origin-when-cross-origin",
                                    body: null,
                                    method: "GET",
                                    mode: "cors",
                                    credentials: "include",
                                    cookie: cookies,
                                }
                            );

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
                    systemLogger.log("getUsersJobsData() error. Error: " + err);
                    console.log({dataTemp});
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
                    systemLogger.log(
                        "Not logged into MJ. Please send login credentials."
                    );
                    let uName = "";
                    let pWord = "";
                    let mfaCb = null;
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
                        log6(
                            "Username: " + username + " Password: " + password
                        );
                        uName = username;
                        pWord = password;
                        mfaCb = async () => {
                            systemLogger.log(
                                "MFA code requested. Please send MFA code."
                            );
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
                                    log1(
                                        "getUsersLikesData(): Timed out waiting for MFA code."
                                    );
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
                            log1(
                                "getUsersLikesData(): Timed out waiting for login credentials."
                            );
                            break;
                        }
                        await waitSeconds(1);
                    }
                    return { uName, pWord, mfaCb };
                };
                await this.loginToMJ(uNamePWordCb).catch((err) => {
                    log0(
                        "getUsersLikesData() error. Not logged into MJ. Error: " +
                            err
                    );
                    reject("Not logged into MJ. Error: " + err);
                });
            }
            let waitCount = 0;
            while (this.loginInProgress) {
                await waitSeconds(1);
                waitCount++;
                if (waitCount > 60 * 5) {
                    log0(
                        "getUsersLikesData() error. Login in progress for too long"
                    );
                    reject("Login in progress for too long");
                }
            }
            await waitSeconds(2);
            let dataTemp = {};
            this.page
                ?.goto("https://www.midjourney.com/imagine", {
                    waitUntil: "networkidle2",
                    timeout: 60000,
                })
                .then(async () => {
                    log6("Navigated to MJ home page.");
                    log6("Getting user's likes data.");
                    let data = await this.page.evaluate(async () => {
                        let numberOfLikesReturned = 0;
                        let page = 1;
                        let loopCount = 0;
                        let returnedData = [];
                        do {
                            // let response = await fetch("https://www.midjourney.com/api/pg/thomas-likes?user_id=" + userUUID + "&page_size=10000" + (cursor == "" ? "" : "&cursor=" + cursor));

                            // fetch("https://www.midjourney.com/api/pg/user-likes?page=2&_ql=explore", {headers: {"sec-ch-ua":'"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',"sec-ch-ua-mobile": "?0",
                                /*        "sec-ch-ua-platform": '"Windows"',
                                        "x-csrf-protection": "1",
                                        Referer:
                                            "https://www.midjourney.com/explore?tab=likes",
                                        "Referrer-Policy":
                                            "origin-when-cross-origin",
                                    },
                                    body: null,
                                    method: "GET",
                                }
                            );*/

                            let response = await fetch(
                                "https://www.midjourney.com/api/pg/user-likes?page=" +
                                    page +
                                    "&_ql=explore",
                                {
                                    headers: {
                                        "sec-ch-ua":
                                            '"Google Chrome";v="127", "Not)A;Brand";v="99", "Chromium";v="123"',
                                        "sec-ch-ua-mobile": "?0",
                                        "sec-ch-ua-platform": '"Windows"',
                                        "x-csrf-protection": "1",
                                        Referer:
                                            "https://www.midjourney.com/explore?tab=likes",
                                        "Referrer-Policy":
                                            "origin-when-cross-origin",
                                    },
                                    body: null,
                                    method: "GET",
                                }
                            );

                            let data = await response.json();
                            // log2({data});
                            dataTemp = data;
                            if (data.jobs.length == 0) break;
                            numberOfLikesReturned = data.jobs.length;
                            // put all the returned data into the returnedData array
                            returnedData.push(...data.jobs);
                            page++;
                            loopCount++;
                            if (loopCount > 10000) {
                                break; // if we've returned more than 500,000 likes, there's probably something wrong, and there's gonna be problems
                            }
                        } while (numberOfLikesReturned == 50);
                        return returnedData;
                    });
                    resolve(data);
                })
                .catch((err) => {
                    log0("getUsersLikesData() error. Error: " + err);
                    systemLogger.log(
                        "getUsersLikesData() error. Error: " + err
                    );
                    systemLogger.log("dataTemp: " + JSON.stringify(dataTemp));
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
                waitUntil: "networkidle2",
                timeout: 60000,
            });
            log6("Navigated to MJ home page.");
            log6("Getting job status data for jobID: " + jobID);
            let data = await this.page.evaluate(async (jobID) => {
                let res1 = await fetch(
                    "https://www.midjourney.com/api/app/job-status",
                    {
                        headers: {
                            accept: "*/*",
                            "accept-language": "en-US,en;q=0.9",
                            "content-type": "application/json",
                            "sec-ch-ua":
                                '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
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
                    }
                );
                let res2 = await res1.json();
                if (res2.length > 0) return res2[0];
                else return null;
            }, jobID);
            resolve(data);
        });
    }
}

class ServerStatusMonitor {
    constructor(
        SystemLogger,
        PuppeteerClient,
        DownloadManager,
        DatabaseManager,
        UpscaleManager,
        DatabaseUpdateManager
    ) {
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
        status.upTimeFormatted =
            (upTimeDays > 0 ? upTimeDays + " days, " : "") +
            (upTimeHours > 0 ? upTimeHours + " hours, " : "") +
            (upTimeMinutes > 0 ? upTimeMinutes + " minutes, " : "") +
            upTimeSeconds +
            " seconds";

        status.numberOfLogEntries = this.systemLogger.getNumberOfEntries();

        status.database = {};
        status.database.numberOfImages = await this.dbClient.countImagesTotal();
        status.database.numberOfImagesDownloaded =
            await this.dbClient.countImagesDownloaded();
        status.database.errorCount = DB_Error.count;

        status.puppeteerClient = {};
        status.puppeteerClient.loggedIntoMJ = this.puppeteerClient.loggedIntoMJ;
        status.puppeteerClient.loginInProgress =
            this.puppeteerClient.loginInProgress;

        status.downloadManager = {};
        status.downloadManager.downloadsInProgress =
            this.downloadManager.concurrentDownloads;
        status.downloadManager.timeToDownload =
            this.downloadManager.timeToDownload;
        status.downloadManager.runEnabled =
            this.downloadManager.downloadRunEnabled;
        status.downloadManager.downloadLocation =
            this.downloadManager.downloadLocation;

        status.upscalerManager = {};
        status.upscalerManager.upscaleInProgress =
            this.upscalerManager.upscaleInProgress;
        status.upscalerManager.runningUpscales =
            this.upscalerManager.runningUpscales;
        status.upscalerManager.queuedUpscales =
            this.upscalerManager.queuedUpscales;
        status.upscalerManager.timeToUpscale =
            this.upscalerManager.timeToUpscale;
        status.upscalerManager.runEnabled = this.upscalerManager.runEnabled;

        status.databaseUpdateManager = {};
        status.databaseUpdateManager.updateInProgress =
            this.databaseUpdateManager.updateInProgress;
        status.databaseUpdateManager.timeToUpdate =
            this.databaseUpdateManager.timeToUpdate;
        status.databaseUpdateManager.runEnabled =
            this.databaseUpdateManager.runEnabled;
        log6("checkServerStatus() complete");
        return status;
    }
}

class Database {
    static DB_connected = false;
    constructor() {
        log5("Database constructor called");
        this.dbClient = new pgClient.Client({
            user: "mjuser",
            host: "postgresql.lan",
            database: "mjimages",
            password: "mjImagesPassword",
            port: 9543,
        });
        this.dbClient
            .connect()
            .then(() => {
                log2("Connected to database");
                Database.DB_connected = true;
            })
            .catch((err) => {
                log0("Error connecting to database:", err);
            });
        this.dbClient.on("error", (err) => {
            new DB_Error("Database error: " + err);
            if (
                typeof err === "string" &&
                err.includes("Connection terminated unexpectedly")
            )
                this.dbClient.connect();
        });
    }

    /**
     * Inserts an image into the database. If the image already exists, it will update the image.
     * @param {ImageInfo} image
     * @param {number} index
     * @returns query response
     */
    insertImage = async (image, index) => {
        log5("insertImage() called");
        log6(
            "insertImage()\nindex: " +
                index +
                "\nimage: " +
                JSON.stringify(image)
        );
        // find if image exists in database
        // if it does, update it
        let lookup = await this.lookupByUUID(image.id);
        if (lookup !== undefined) {
            image.processed = lookup.processed;
            image.downloaded = lookup.downloaded;
            image.doNotDownload = lookup.do_not_download;
            image.storageLocation = lookup.storage_location;
            image.upscale_location = lookup.upscale_location;
            await this.updateImage(image);
            return;
        }

        // if it doesn't exist, insert it
        image.processed = false;
        let res;
        try {
            res = await this.dbClient.query(
                `INSERT INTO images (uuid, parent_uuid, grid_index, enqueue_time, full_command, width, height, storage_location, downloaded, do_not_download, processed, index, upscale_location) 
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, null)`,
                [
                    image.id,
                    image.parent_id,
                    image.grid_index,
                    image.enqueue_time,
                    image.fullCommand,
                    image.width,
                    image.height,
                    image.storageLocation,
                    image.downloaded !== null && image.downloaded !== undefined
                        ? image.downloaded
                        : false,
                    image.doNotDownload !== null &&
                    image.doNotDownload !== undefined
                        ? image.doNotDownload
                        : false,
                    image.processed !== null && image.processed !== undefined
                        ? image.processed
                        : false,
                    index,
                ]
            );
        } catch (err) {
            log0(
                "insertImage() error: Error inserting image into database. Image ID: " +
                    image.id +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error inserting image into database. Image ID: " +
                    image.id +
                    "Error: " +
                    err
            );
            return null;
        }
        log6("insertImage() complete");
        return res;
    };

    /**
     * Looks up an image in the database by uuid.
     * @param {string} uuid
     * @returns Query response. If the image is found, it will return the image. If the image is not found, it will return undefined.
     */
    lookupByUUID = async (uuid) => {
        log5("lookupByUUID() called");
        log6("lookupByUUID()\nuuid: " + uuid);
        try {
            const res = await this.dbClient.query(
                `SELECT * FROM images WHERE uuid = $1`,
                [uuid]
            );

            if (res.rows.length > 0) {
                if (res.rows.length > 1)
                    log1(
                        "lookupByUUID() warning: Multiple images found in database. Image ID: " +
                            uuid
                    );
                log6("lookupByUUID() complete");
                return res.rows[0];
            }
            log1(
                "lookupByUUID() Image not found in database. Image ID: " + uuid
            );
            log6("lookupByUUID() complete");
            return undefined;
        } catch (err) {
            log0(
                "lookupByUUID() error: Error looking up image in database. Image ID: " +
                    uuid +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error looking up image in database. Image ID: " + uuid
            );
            log6("lookupByUUID() complete");
            return null;
        }
    };

    /**
     * Get a random image from the database. If downloadedOnly is true, it will only return images that have been downloaded.
     * @param {boolean} downloadedOnly
     * @returns Query response. If the image is found, it will return the image. If the image is not found, it will return undefined.
     */
    getRandomImage = async (downloadedOnly = false) => {
        log5("getRandomImage() called");
        log6("getRandomImage()\ndownloadedOnly: " + downloadedOnly);
        if (downloadedOnly === "true") downloadedOnly = true;
        if (downloadedOnly === "false") downloadedOnly = false;
        if (typeof downloadedOnly !== "boolean") downloadedOnly = false;
        try {
            let res;
            if (downloadedOnly) {
                res = await this.dbClient.query(
                    `SELECT * FROM images WHERE downloaded = $1 AND do_not_download = $2 ORDER BY RANDOM() / (times_selected+1) DESC LIMIT 1`,
                    [true, false]
                );
            } else {
                res = await this.dbClient.query(
                    `SELECT * FROM images ORDER BY RANDOM() / (times_selected+1) DESC LIMIT 1`
                );
            }
            log6(
                "getRandomImage() res.rows.length: " +
                    res.rows.length +
                    " res.rows: " +
                    JSON.stringify(res.rows)
            );
            if (res.rows.length > 0) {
                if (res.rows.length > 1)
                    log1(
                        "getRandomImage() warning: Multiple images found in database."
                    );
                log6("getRandomImage() complete");
                return res.rows[0];
            }
            log1("getRandomImage() Image not found in database.");
            log6("getRandomImage() complete");
            return undefined;
        } catch (err) {
            log0(
                "getRandomImage() error: Error looking up random image in database. Error: " +
                    err
            );
            new DB_Error("Error looking up random image in database");
            log6("getRandomImage() complete");
            return null;
        }
    };

    /**
     * Look up images in the database by range of indexes.
     * @param {number | string} indexStart
     * @param {number | string} indexEnd
     * @param {object} processedOnly { processed: false, enabled: false}
     * @param {object} downloadedOnly { downloaded: false, enabled: false}
     * @param {object} do_not_downloadOnly { do_not_download: false, enabled: false}
     * @returns Query response. If the images are found, it will return the images. If the range is invalid, it will return null. If the images are not found, it will return undefined.
     */
    lookupImagesByIndexRange = async (
        indexStart,
        indexEnd,
        processedOnly = { processed: false, enabled: false },
        downloadedOnly = { downloaded: false, enabled: false },
        do_not_downloadOnly = { do_not_download: false, enabled: false }
    ) => {
        log5("lookupImagesByIndexRange() called");
        log6(
            "lookupImagesByIndexRange()\nindexStart: " +
                indexStart +
                "\nindexEnd: " +
                indexEnd +
                "\nprocessedOnly: " +
                JSON.stringify(processedOnly) +
                "\ndownloadedOnly: " +
                JSON.stringify(downloadedOnly) +
                "\ndo_not_downloadOnly: " +
                JSON.stringify(do_not_downloadOnly)
        );
        if (typeof indexStart === "number") indexStart = indexStart.toString();
        if (typeof indexStart === "string") {
            try {
                indexStart = parseInt(indexStart);
            } catch {
                log1(
                    "lookupImagesByIndexRange() unable to parse indexStart. indexStart: " +
                        indexStart
                );
                log6("lookupImagesByIndexRange() complete");
                return null;
            }
            indexStart = indexStart.toString();
        } else {
            log1(
                "lookupImagesByIndexRange() unable to parse indexStart. indexStart: " +
                    indexStart
            );
            log6("lookupImagesByIndexRange() complete");
            return null;
        }
        if (typeof indexEnd === "number") indexEnd = indexEnd.toString();
        if (typeof indexEnd === "string") {
            try {
                indexEnd = parseInt(indexEnd);
            } catch {
                log1(
                    "lookupImagesByIndexRange() unable to parse indexEnd. indexEnd: " +
                        indexEnd
                );
                log6("lookupImagesByIndexRange() complete");
                return null;
            }
            indexEnd = indexEnd.toString();
        } else {
            log1(
                "lookupImagesByIndexRange() unable to parse indexEnd. indexEnd: " +
                    indexEnd
            );
            log6("lookupImagesByIndexRange() complete");
            return null;
        }
        // at this point indexStart and indexEnd should be strings that are numbers. Anything else would have returned null
        try {
            let queryParts = [
                "SELECT * FROM images WHERE id >= $1 AND id < $2",
            ];
            let queryParams = [indexStart, indexEnd];

            if (processedOnly.enabled === true) {
                queryParts.push(
                    "AND processed = " +
                        (processedOnly.processed === true ? "true" : "false")
                );
                log6(
                    "lookupImagesByIndexRange() processedOnly enabled, processed: " +
                        processedOnly.processed
                );
            }
            if (downloadedOnly.enabled === true) {
                queryParts.push(
                    "AND downloaded = " +
                        (downloadedOnly.downloaded === true ? "true" : "false")
                );
                log6(
                    "lookupImagesByIndexRange() downloadedOnly enabled, downloaded: " +
                        downloadedOnly.downloaded
                );
            }
            if (do_not_downloadOnly.enabled === true) {
                queryParts.push(
                    "AND do_not_download = " +
                        (do_not_downloadOnly.do_not_download === true
                            ? "true"
                            : "false")
                );
                log6(
                    "lookupImagesByIndexRange() do_not_downloadOnly enabled, do_not_download: " +
                        do_not_downloadOnly.do_not_download
                );
            }

            // log2(queryParts.join(' '), queryParams); // TODO: remove this

            const res = await this.dbClient.query(
                queryParts.join(" "),
                queryParams
            );
            log6(
                "lookupImagesByIndexRange() res.rows.length: " + res.rows.length
            );
            if (res.rows.length > 0) {
                log6("lookupImagesByIndexRange() complete");
                return res.rows;
            }
            log1(
                "lookupImagesByIndexRange() Images not found in database. Image index range: " +
                    indexStart +
                    " to " +
                    indexEnd
            );
            log6("lookupImagesByIndexRange() complete");
            return undefined;
        } catch (err) {
            log0(
                "lookupImagesByIndexRange() error: Error looking up images in database. Image index range: " +
                    indexStart +
                    " to " +
                    indexEnd +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error looking up images in database. Image index range: " +
                    indexStart +
                    " to " +
                    indexEnd
            );
            log6("lookupImagesByIndexRange() complete");
            return null;
        }
    };

    /**
     * Look up image in the database by index.
     * @param {number | string} index
     * @param {object} processedOnly { processed: false, enabled: false}
     * @param {object} downloadedOnly { downloaded: false, enabled: false}
     * @param {object} do_not_downloadOnly { do_not_download: false, enabled: false}
     * @returns Query response. If the image is found, it will return the image. If the image is not found, it will return undefined.
     */
    lookupImageByIndex = async (
        index,
        processedOnly = { processed: false, enabled: false },
        downloadedOnly = { downloaded: false, enabled: false },
        do_not_downloadOnly = { do_not_download: false, enabled: false }
    ) => {
        log5("lookupImageByIndex() called");
        log6(
            "lookupImageByIndex()\nindex: " +
                index +
                "\nprocessedOnly: " +
                JSON.stringify(processedOnly) +
                "\ndownloadedOnly: " +
                JSON.stringify(downloadedOnly) +
                "\ndo_not_downloadOnly: " +
                JSON.stringify(do_not_downloadOnly)
        );
        if (typeof index === "number") index = index.toString();
        if (typeof index === "string") {
            try {
                index = parseInt(index);
            } catch {
                log1(
                    "lookupImageByIndex() unable to parse index. index: " +
                        index
                );
                log6("lookupImageByIndex() complete");
                return null;
            }
            index = index.toString();
        } else {
            log1("lookupImageByIndex() unable to parse index. index: " + index);
            log6("lookupImageByIndex() complete");
            return null;
        }
        // at this point index should be a string that is a number. Anything else would have returned null
        try {
            let queryParts = ["SELECT * FROM images WHERE id = $1"];
            let queryParams = [index];

            if (processedOnly.enabled === true) {
                queryParts.push(
                    "AND processed = " +
                        (processedOnly.processed === true ? "true" : "false")
                );
                log6(
                    "lookupImageByIndex() processedOnly enabled, processed: " +
                        processedOnly.processed
                );
            }
            if (downloadedOnly.enabled === true) {
                queryParts.push(
                    "AND downloaded = " +
                        (downloadedOnly.downloaded === true ? "true" : "false")
                );
                log6(
                    "lookupImageByIndex() downloadedOnly enabled, downloaded: " +
                        downloadedOnly.downloaded
                );
            }
            if (do_not_downloadOnly.enabled === true) {
                queryParts.push(
                    "AND do_not_download = " +
                        (do_not_downloadOnly.do_not_download === true
                            ? "true"
                            : "false")
                );
                log6(
                    "lookupImageByIndex() do_not_downloadOnly enabled, do_not_download: " +
                        do_not_downloadOnly.do_not_download
                );
            }

            queryParts.push("LIMIT 1");

            // log2(queryParts.join(' '), queryParams); // TODO: remove this

            const res = await this.dbClient.query(
                queryParts.join(" "),
                queryParams
            );
            if (res.rows.length == 1) {
                log6("lookupImageByIndex() complete");
                return res.rows[0];
            } else if (res.rows.length > 1) {
                new DB_Error(
                    "Error looking up image in database. Too many rows returned. Image index: " +
                        index
                );
            } else if (res.rows.length == 0) {
                log1(
                    "lookupImageByIndex() Image not found in database. Image index: " +
                        index
                );
                log6("lookupImageByIndex() complete");
                return undefined;
            }
            log1(
                "lookupImageByIndex() Image not found in database. Image index: " +
                    index
            );
            log6("lookupImageByIndex() complete");
            return undefined;
        } catch (err) {
            log0(
                "lookupImageByIndex() error: Error looking up image in database. Image index: " +
                    index +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error looking up image in database. Image index: " + index
            );
            log6("lookupImageByIndex() complete");
            return null;
        }
    };

    /**
     * Update an image in the database
     * @param {ImageInfo} image
     * @returns Query response
     */
    updateImage = async (image) => {
        log5("updateImage() called");
        log6("updateImage()\nimage: " + JSON.stringify(image));
        try {
            const res = await this.dbClient.query(
                `UPDATE images SET 
                parent_uuid = COALESCE($1, parent_uuid),
                grid_index = COALESCE($2, grid_index),
                enqueue_time = COALESCE($3, enqueue_time),
                full_command = COALESCE($4, full_command),
                width = COALESCE($5, width),
                height = COALESCE($6, height),
                storage_location = COALESCE($7, storage_location),
                downloaded = COALESCE($8, downloaded),
                do_not_download = COALESCE($9, do_not_download),
                processed = COALESCE($10, processed),
                upscale_location = COALESCE($11, upscale_location)
                WHERE uuid = $12`,
                [
                    image.parent_id !== null && image.parent_id !== undefined
                        ? image.parent_id
                        : image.parent_uuid !== null &&
                          image.parent_uuid !== undefined
                        ? image.parent_uuid
                        : null,
                    image.grid_index !== null && image.grid_index !== undefined
                        ? image.grid_index
                        : null,
                    image.enqueue_time !== null &&
                    image.enqueue_time !== undefined
                        ? image.enqueue_time
                        : null,
                    image.fullCommand !== null &&
                    image.fullCommand !== undefined
                        ? image.fullCommand
                        : null,
                    image.width !== null && image.width !== undefined
                        ? image.width
                        : null,
                    image.height !== null && image.height !== undefined
                        ? image.height
                        : null,
                    image.storageLocation !== null &&
                    image.storageLocation !== undefined
                        ? image.storageLocation
                        : image.storage_location !== null &&
                          image.storage_location !== undefined
                        ? image.storage_location
                        : null,
                    image.downloaded !== null && image.downloaded !== undefined
                        ? image.downloaded
                        : null,
                    image.doNotDownload !== null &&
                    image.doNotDownload !== undefined
                        ? image.doNotDownload
                        : null,
                    image.processed !== null && image.processed !== undefined
                        ? image.processed
                        : null,
                    image.upscale_location !== null &&
                    image.upscale_location !== undefined
                        ? image.upscale_location
                        : null,
                    image.id !== null && image.id !== undefined
                        ? image.id
                        : image.parent_uuid !== null &&
                          image.parent_uuid !== undefined &&
                          image.grid_index !== null &&
                          image.grid_index !== undefined
                        ? image.parent_uuid + "_" + image.grid_index
                        : null,
                ]
            );
            log6("updateImage() complete");
            return res;
        } catch (err) {
            log0(
                "updateImage() error: Error updating image in database. Image ID: " +
                    image.id +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error updating image in database. Image ID: " + image.id
            );
            log6("updateImage() complete");
            return null;
        }
    };
    /**
     * Delete an image in the database
     * @param {string} uuid
     * @returns Query response
     */
    deleteImage = async (uuid) => {
        log5("deleteImage() called");
        log6("deleteImage()\nuuid: " + uuid);
        try {
            const res = await this.dbClient.query(
                `DELETE FROM images WHERE uuid = $1`,
                [uuid]
            );
            log6("deleteImage() complete");
            return res;
        } catch (err) {
            log0(
                "deleteImage() error: Error deleting image from database. Image ID: " +
                    uuid +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error deleting image from database. Image ID: " + uuid
            );
            log6("deleteImage() complete");
            return null;
        }
    };
    countImagesTotal = async () => {
        log5("countImagesTotal() called");
        try {
            const res = await this.dbClient.query(
                `SELECT COUNT(*) FROM images`
            );
            log6("countImagesTotal() complete");
            return res.rows[0].count;
        } catch (err) {
            log0(
                "countImagesTotal() error: Error counting images in database. Error: " +
                    err
            );
            new DB_Error("Error counting images in database");
            log6("countImagesTotal() complete");
            return null;
        }
    };
    countImagesDownloaded = async () => {
        log5("countImagesDownloaded() called");
        try {
            const res = await this.dbClient.query(
                `SELECT COUNT(*) FROM images WHERE downloaded = true`
            );
            log6("countImagesDownloaded() complete");
            return res.rows[0].count;
        } catch (err) {
            log0(
                "countImagesDownloaded() error: Error counting downloaded images in database. Error: " +
                    err
            );
            new DB_Error("Error counting downloaded images in database");
            log6("countImagesDownloaded() complete");
            return null;
        }
    };
    setImageProcessed = async (uuid, valueBool = true) => {
        log5("setImageProcessed() called");
        log6(
            "setImageProcessed()\nuuid: " + uuid + "\nvalueBool: " + valueBool
        );
        if (typeof valueBool === "string") valueBool = valueBool === "true";
        if (typeof valueBool !== "boolean") {
            log1("setImageProcessed() error: valueBool must be a boolean");
            log6("setImageProcessed() complete");
            return null;
        }
        try {
            const res = await this.dbClient.query(
                `UPDATE images SET processed = $1 WHERE uuid = $2`,
                [valueBool, uuid]
            );
            log6("setImageProcessed() complete");
            return res;
        } catch (err) {
            log0(
                "setImageProcessed() error: Error setting image processed in database. Image ID: " +
                    uuid +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error setting image processed in database. Image ID: " + uuid
            );
            log6("setImageProcessed() complete");
            return null;
        }
    };
    updateTimesSelectedPlusOne = async (uuid) => {
        log5("updateTimesSelectedPlusOne() called");
        log6("updateTimesSelectedPlusOne()\nuuid: " + uuid);
        try {
            // get times_selected for uuid
            let res = await this.dbClient.query(
                `SELECT times_selected FROM images WHERE uuid = $1`,
                [uuid]
            );
            let timesSelected = res.rows[0].times_selected;
            log6(
                "updateTimesSelectedPlusOne() timesSelected: " + timesSelected
            );
            // add 1 to it
            timesSelected++;
            log6(
                "updateTimesSelectedPlusOne() timesSelected: " + timesSelected
            );
            // update times_selected for uuid
            res = await this.dbClient.query(
                `UPDATE images SET times_selected = $1 WHERE uuid = $2`,
                [timesSelected, uuid]
            );
            log6("updateTimesSelectedPlusOne() complete");
        } catch (err) {
            log0(
                "updateTimesSelectedPlusOne() error: Error updating times_selected in database. Image ID: " +
                    uuid +
                    "Error: " +
                    err
            );
            new DB_Error(
                "Error updating times_selected in database. Image ID: " + uuid
            );
            log6("updateTimesSelectedPlusOne() complete");
            return null;
        }
    };

    setAllImagesSelectedCountZero = async () => {
        log5("setAllImagesSelectedCountZero() called");
        try {
            const res = await this.dbClient.query(
                `UPDATE images SET times_selected = 0`
            );
            log6("setAllImagesSelectedCountZero() complete");
            return res;
        } catch (err) {
            log0(
                "setAllImagesSelectedCountZero() error: Error setting all images selected count to zero. Error: " +
                    err
            );
            new DB_Error("Error setting all images selected count to zero");
            log6("setAllImagesSelectedCountZero() complete");
            return null;
        }
    };

    getEntriesOrderedByEnqueueTime = async (limit = 100, offset = 0) => {
        log5("getEntriesOrderedByEnqueueTime() called");
        log6(
            "getEntriesOrderedByEnqueueTime()\nlimit: " +
                limit +
                "\noffset: " +
                offset
        );
        if (typeof limit === "string") {
            try {
                limit = parseInt(limit);
            } catch {
                limit = 100;
            }
        }
        if (typeof offset === "string") {
            try {
                offset = parseInt(offset);
            } catch {
                offset = 0;
            }
        }
        if (typeof limit !== "number") limit = 100;
        if (typeof offset !== "number") offset = 0;
        try {
            const res = await this.dbClient.query(
                `SELECT * FROM images 
                ORDER BY enqueue_time DESC 
                LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
            log6(
                "getEntriesOrderedByEnqueueTime() res.rows.length: " +
                    res.rows.length
            );
            log6("getEntriesOrderedByEnqueueTime() complete");
            return res.rows;
        } catch (err) {
            log0(
                "getEntriesOrderedByEnqueueTime() error: Error getting entries ordered by enqueue_time. Error: " +
                    err
            );
            new DB_Error("Error getting entries ordered by enqueue_time");
            log6("getEntriesOrderedByEnqueueTime() complete");
            return null;
        }
    };
}

class ImageInfo {
    constructor(
        parent_id,
        grid_index,
        enqueue_time,
        fullCommand,
        width,
        height,
        storage_location = "",
        upscale_location = ""
    ) {
        log5("ImageInfo constructor called");
        log6(
            "ImageInfo constructor\nparent_id: " +
                parent_id +
                "\ngrid_index: " +
                grid_index +
                "\nenqueue_time: " +
                enqueue_time +
                "\nfullCommand: " +
                fullCommand +
                "\nwidth: " +
                width +
                "\nheight: " +
                height +
                "\nstorage_location: " +
                storage_location +
                "\nupscale_location: " +
                upscale_location
        );
        this.parent_id = parent_id;
        this.grid_index = grid_index;
        this.enqueue_time = enqueue_time;
        this.fullCommand = fullCommand;
        // this.fullCommand = fullCommand.replace(/'/g, "\\'");
        this.upscale_location = upscale_location;
        this.width = width;
        this.height = height;
        this.storageLocation = storage_location;
        this.downloaded = null;
        this.doNotDownload = null;
        this.processed = null;
    }

    toJSON() {
        log5("ImageInfo toJSON() called");
        let t = { ...this };
        t.urlFull = this.urlFull;
        t.urlSmall = this.urlSmall;
        t.urlMedium = this.urlMedium;
        t.urlAlt = this.urlAlt;
        t.urlParentGrid = this.urlParentGrid;
        log6("ImageInfo toJSON() complete");
        return t;
    }

    get id() {
        return this.parent_id + "_" + this.grid_index;
    }
    get urlFull() {
        return `https://cdn.midjourney.com/${this.parent_id}/0_${this.grid_index}.png`;
    }
    get urlSmall() {
        return `https://cdn.midjourney.com/${this.parent_id}/0_${this.grid_index}_32_N.webp`;
    }
    get urlMedium() {
        return `https://cdn.midjourney.com/${this.parent_id}/0_${this.grid_index}_384_N.webp`;
    }
    get urlAlt() {
        return `https://storage.googleapis.com/dream-machines-output/${this.parent_id}/0_${this.grid_index}.png`;
    }
    get urlParentGrid() {
        return `https://cdn.midjourney.com/${this.parent_id}/grid_0.webp`;
    }
}

class DatabaseUpdateManager {
    static updateInProgress_static = false;
    constructor(
        DatabaseManager = null,
        SystemLogger = null,
        PuppeteerClient = null
    ) {
        log5("DatabaseUpdateManager constructor called");
        log6(
            "DatabaseUpdateManager constructor\nDatabaseManager: " +
                DatabaseManager +
                "\nSystemLogger: " +
                SystemLogger +
                "\nPuppeteerClient: " +
                PuppeteerClient
        );
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
        let timeToUpdate = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            this.timeToUpdate / 60,
            this.timeToUpdate % 60,
            0,
            0
        );
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
            log1(
                "DatabaseUpdateManager.run() warning: Run is disabled. Run will not start."
            );
            this.start();
            return;
        }
        if (DownloadManager.downloadInProgress_static === true) {
            log1(
                "DatabaseUpdateManager.run() warning: Download is in progress. Will try again in 5 minutes."
            );
            this.runTimeout = setTimeout(() => this.run(), 1000 * 60 * 5);
            return;
        }
        if (this.updateInProgress === true) return;
        this.updateInProgress = true;
        DatabaseUpdateManager.updateInProgress_static = true;
        log6(
            "DatabaseUpdateManager.run() updateInProgress: " +
                this.updateInProgress
        );
        await this.updateUsersJobs();
        await this.updateUsersLikes();
        log6("DatabaseUpdateManager.run() complete");
    }
    async updateUsersJobs() {
        log5("DatabaseUpdateManager.updateUsersJobs() called");
        await this.puppeteerClient
            .getUsersJobsData()
            .then(async (data) => {
                log4(typeof data);
                log4(
                    "Size of data: ",
                    data.length,
                    "\nCalling buildImageData()"
                );
                let imageData = buildImageData(data);
                log2(
                    "Size of data: ",
                    imageData.length,
                    "\nDone building imageData\nUpdating database"
                );
                for (let i = 0; i < imageData.length; i++) {
                    if (updateDB) await imageDB.insertImage(imageData[i], i);
                }
                // log2("Done updating database");
            })
            .catch((err) => {
                log2(err);
                this.systemLogger.log("Error getting user's jobs data", err);
                log0([
                    "DatabaseUpdateManager.run() error: Error getting user's jobs data",
                    err,
                ]);
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
                log4(
                    "Size of data: ",
                    data.length,
                    "\nCalling buildImageData()"
                );
                let imageData = buildImageData(data);
                log2(
                    "Size of data: ",
                    imageData.length,
                    "\nDone building imageData\nUpdating database"
                );
                for (let i = 0; i < imageData.length; i++) {
                    if (updateDB) await imageDB.insertImage(imageData[i], i);
                }
                log2("Done updating database");
            })
            .catch((err) => {
                log2(err);
                this.systemLogger.log("Error getting user's likes data", err);
                log0([
                    "DatabaseUpdateManager.run() error: Error getting user's likes data",
                    err,
                ]);
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

class DownloadManager {
    static downloadInProgress_static = false;
    constructor(
        DatabaseManager = null,
        SystemLogger = null,
        UpscaleManager = null
    ) {
        log5("DownloadManager constructor called");
        log6(
            "DownloadManager constructor\nDatabaseManager: " +
                DatabaseManager +
                "\nSystemLogger: " +
                SystemLogger +
                "\nUpscaleManager: " +
                UpscaleManager
        );
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
        log6("DownloadManager constructor complete");
    }

    setDownloadLocation(location) {
        log5("DownloadManager.setDownloadLocation() called");
        log6("DownloadManager.setDownloadLocation()\nlocation: " + location);
        this.downloadLocation = location;
        let stats = fs.statSync(this.downloadLocation);
        if (!stats.isDirectory()) {
            log1(
                "DownloadManager.setDownloadLocation() warning: Download location is not a directory. Download location: " +
                    this.downloadLocation
            );
            return false;
        }
        try {
            if (!fs.existsSync(this.downloadLocation))
                fs.mkdirSync(this.downloadLocation, { recursive: true });
        } catch (err) {
            log0([
                "DownloadManager.setDownloadLocation() error: Error creating download location directory",
                err,
            ]);
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
                log0([
                    "DownloadManager.setTimeToDownload() error: Error parsing time to download",
                    time,
                ]);
                return false;
            }
        }
        if (typeof time !== "number") {
            log1(
                "DownloadManager.setTimeToDownload(): Time to download is not a number. time: " +
                    time
            );
            return false;
        }
        this.timeToDownload = time;
        if (this.timeToDownload < 0) this.timeToDownload = 0;
        if (this.timeToDownload > 1440)
            this.timeToDownload = this.timeToDownload % 1440;
        log6("DownloadManager.setTimeToDownload() complete");
        return true;
    }

    async downloadImage(url, image) {
        log5("DownloadManager.downloadImage() called");
        log6(
            "DownloadManager.downloadImage()\nurl: " +
                url +
                "\nimage: " +
                JSON.stringify(image)
        );
        let response;
        try {
            response = await fetch(url);
        } catch (err) {
            log0([
                "DownloadManager.downloadImage() error: Error downloading image",
                err,
                image,
            ]);
            return { success: false, error: err };
        }

        if (!response.ok) {
            log0([
                "DownloadManager.downloadImage() error: Bad response code",
                response.status,
                image,
            ]);
            return {
                success: false,
                error: "Bad response code: " + response.status,
            };
        }
        if (response.headers.get("content-type") !== "image/png") {
            log0([
                "DownloadManager.downloadImage() error: Bad content type",
                response.headers.get("content-type"),
                image,
            ]);
            return {
                success: false,
                error: "Bad content type: " + response.headers["content-type"],
            };
        }
        if (parseInt(response.headers.get("content-length"), 10) < 1000) {
            log0([
                "DownloadManager.downloadImage() error: Bad content length",
                response.headers.get("content-length"),
                image,
            ]);
            return {
                success: false,
                error:
                    "Bad content length: " + response.headers["content-length"],
            };
        }
        log6("DownloadManager.downloadImage() Fetch successful");

        let contentLength = parseInt(
            response.headers.get("content-length"),
            10
        );
        log6("DownloadManager.downloadImage() contentLength: " + contentLength);
        let imageDate = new Date(image.enqueue_time);
        log6("DownloadManager.downloadImage() imageDate: " + imageDate);
        let year = imageDate.getFullYear();
        let month = imageDate.getMonth() + 1;
        let day = imageDate.getDate();
        let destFolder =
            this.downloadLocation + "/" + year + "/" + month + "/" + day;
        log6("DownloadManager.downloadImage() destFolder: " + destFolder);
        if (!fs.existsSync(destFolder)) {
            log1(
                "DownloadManager.downloadImage() warning: Destination folder does not exist. Creating it now. Folder: " +
                    destFolder
            );
            fs.mkdirSync(destFolder, { recursive: true });
        }
        let splitImage = url.split("/");
        let destFileName =
            splitImage[splitImage.length - 2] +
            "-" +
            splitImage[splitImage.length - 1];
        log6("DownloadManager.downloadImage() destFileName: " + destFileName);

        if (fs.existsSync(path.join(destFolder, destFileName))) {
            // delete file
            log1(
                "DownloadManager.downloadImage() warning: File already exists. Deleting it now. File: " +
                    path.join(destFolder, destFileName)
            );
            fs.unlinkSync(path.join(destFolder, destFileName));
        }
        let data = await response.arrayBuffer();
        data = Buffer.from(data);
        fs.writeFileSync(path.join(destFolder, destFileName), data);
        let fileSize = 0;
        // await waitSeconds(0.5);
        let file = fs.statSync(path.join(destFolder, destFileName));
        fileSize = file.size;
        fileSize = parseInt(fileSize);
        log6("DownloadManager.downloadImage() fileSize: " + fileSize);
        contentLength = parseInt(contentLength);
        if (fileSize != contentLength) {
            log0([
                "DownloadManager.downloadImage() error: File size mismatch: " +
                    fileSize +
                    " != " +
                    contentLength,
                image,
            ]);
            return {
                success: false,
                error:
                    "File size mismatch: " + fileSize + " != " + contentLength,
            };
            // return;
        }
        log4(
            "Downloaded image " +
                destFileName +
                " of size " +
                fileSize +
                " bytes"
        );
        image.downloaded = true;
        image.storageLocation = path.join(destFolder, destFileName);
        image.processed = true;
        image.fileSize = fileSize;
        image.success = true;
        log6("DownloadManager.downloadImage() complete");
        return image;
    }

    start() {
        log5("DownloadManager.start() called");
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        log6("now: " + now);
        let timeToDownload = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            this.timeToDownload / 60,
            this.timeToDownload % 60,
            0,
            0
        );
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
            log1(
                "DownloadManager.run() warning: Run is disabled. Run will not start."
            );
            this.start();
            return;
        }
        if (this.verifyDownloadsInProgress) {
            log1(
                "DownloadManager.run() warning: Verify downloads is in progress. Will try again in 10 seconds."
            );
            setTimeout(() => this.run(), 10000);
            return;
        }
        if (DatabaseUpdateManager.updateInProgress_static === true) {
            log1(
                "DownloadManager.run() warning: Database update is in progress. Will try again in 5 minutes."
            );
            setTimeout(() => this.run(), 1000 * 60 * 5);
            return;
        }
        if (this.downloadInProgress === true) return;
        this.downloadInProgress = true;
        DownloadManager.downloadInProgress_static = true;
        log6(
            "DownloadManager.run() downloadInProgress: " +
                this.downloadInProgress
        );
        log6("DownloadManager.run() Verifying downloads");
        await this.verifyDownloads();
        this.concurrentDownloads = 0;
        let imageCount = await this.dbClient.countImagesTotal();
        log2("Image count: " + imageCount);
        let success = true;
        for (let i = 0; i < imageCount; i += 100) {
            if (!(await this.lookupAndDownloadImageByIndex(i))) success = false;
        }
        if (success) {
            log2("Done downloading images");
        } else {
            log0("One or more errors occurred while downloading images");
            this.systemLogger.log(
                "One or more errors occurred while downloading images"
            );
            DownloadError.sendErrorCountToSystemLogger();
            DownloadError.resetCount();
        }
        this.downloadInProgress = false;
        DownloadManager.downloadInProgress_static = false;
        this.start();
        log6("DownloadManager.run() complete");
    }

    async lookupAndDownloadImageByIndex(index) {
        log5("DownloadManager.lookupAndDownloadImageByIndex() called");
        log6(
            "DownloadManager.lookupAndDownloadImageByIndex()\nindex: " + index
        );
        if (!this.downloadRunEnabled) {
            log1(
                "DownloadManager.lookupAndDownloadImageByIndex() warning: Run is disabled. Run will not start."
            );
            return true;
        }
        let images = await this.dbClient.lookupImagesByIndexRange(
            index,
            index + 100,
            { processed: true, enabled: true },
            { downloaded: false, enabled: true },
            { do_not_download: false, enabled: true }
        );
        if (images === undefined) {
            log6(
                "DownloadManager.lookupAndDownloadImageByIndex() Image range not found in database. Image index range: " +
                    index +
                    " to " +
                    (index + 100)
            );
            log6("DownloadManager.lookupAndDownloadImageByIndex() complete");
            return true;
        }
        if (images === null) {
            log6(
                "DownloadManager.lookupAndDownloadImageByIndex() Image range not found in database. Image index range: " +
                    index +
                    " to " +
                    (index + 100)
            );
            log6("DownloadManager.lookupAndDownloadImageByIndex() complete");
            return true;
        }
        let success = true;
        for (const element of images) {
            while (this.concurrentDownloads >= 10) await waitSeconds(1);
            (async (image) => {
                image = new ImageInfo(
                    image.parent_uuid,
                    image.grid_index,
                    image.enqueue_time,
                    image.full_command,
                    image.width,
                    image.height
                );

                this.concurrentDownloads++;
                let imageResult;
                try {
                    imageResult = await this.downloadImage(image.urlAlt, image);
                } catch (err) {
                    log0([
                        "DownloadManager.lookupAndDownloadImageByIndex() error: Error downloading image",
                        err,
                        image,
                    ]);
                    // this.systemLogger.log("Error downloading image", err, image);
                    success = false;
                    new DownloadError("Error downloading image", err, image);
                    log6(
                        "DownloadManager.lookupAndDownloadImageByIndex() complete"
                    );
                    return;
                }
                this.concurrentDownloads--;

                if (imageResult.success === true) {
                    await this.dbClient.updateImage(imageResult);
                } else {
                    // this.systemLogger?.log("Error downloading image", imageResult.error, image);
                    new DownloadError(
                        "Error downloading image",
                        imageResult.error,
                        image
                    );
                    log0([
                        "DownloadManager.lookupAndDownloadImageByIndex() error: Error downloading image",
                        imageResult.error,
                        image,
                    ]);
                    let url = image.urlFull;
                    if (
                        typeof imageResult.error == "string" &&
                        imageResult.error.includes("File size mismatch")
                    ) {
                        url = image.urlAlt;
                    }
                    this.concurrentDownloads++;
                    let altImageResult;
                    try {
                        altImageResult = await this.downloadImage(url, image);
                    } catch (err) {
                        log0([
                            "DownloadManager.lookupAndDownloadImageByIndex() error: Error downloading image",
                            err,
                            image,
                        ]);
                        // this.systemLogger.log("Error downloading image", err, image);
                        new DownloadError(
                            "Error downloading image",
                            err,
                            image
                        );
                        success = false;
                        log6(
                            "DownloadManager.lookupAndDownloadImageByIndex() complete"
                        );
                        return;
                    }
                    this.concurrentDownloads--;
                    if (altImageResult.success === true) {
                        await this.dbClient.updateImage(altImageResult);
                    } else {
                        log0([
                            "DownloadManager.lookupAndDownloadImageByIndex() error: Error downloading image",
                            altImageResult.error,
                            image,
                        ]);
                        // this.systemLogger.log("Error downloading image", altImageResult.error, image);
                        new DownloadError(
                            "Error downloading image",
                            altImageResult.error,
                            image
                        );
                        success = false;
                        log6(
                            "DownloadManager.lookupAndDownloadImageByIndex() complete"
                        );
                        return;
                    }
                }
            })(element);
        }
        log6("DownloadManager.lookupAndDownloadImageByIndex() complete");
        return success;
    }

    checkFileExistsPath(path) {
        log6("DownloadManager.checkFileExistsPath() called");
        log6("DownloadManager.checkFileExistsPath()\npath: " + path);
        if (typeof path !== "string") {
            log1(
                "DownloadManager.checkFileExistsPath() warning: path is not a string. path: " +
                    path
            );
            log6("DownloadManager.checkFileExistsPath() complete");
            return false;
        }
        if (path === "") {
            log1(
                "DownloadManager.checkFileExistsPath() warning: path is empty"
            );
            log6("DownloadManager.checkFileExistsPath() complete");
            return false;
        }
        let stats;
        try {
            stats = fs.statSync(path);
        } catch (err) {
            log6(
                "DownloadManager.checkFileExistsPath() complete. Error: " + err
            );
            return false;
        }
        if (stats.isFile()) {
            log6(
                "DownloadManager.checkFileExistsPath() complete. File exists."
            );
            return true;
        }
        log6(
            "DownloadManager.checkFileExistsPath() complete. File does not exist."
        );
        return false;
    }

    async verifyDownloads() {
        log5("DownloadManager.verifyDownloads() called");
        if (this.verifyDownloadsInProgress) {
            log2(
                "DownloadManager.verifyDownloads() warning: Verify downloads is already in progress. Will not start another."
            );
            return;
        }
        this.verifyDownloadsInProgress = true;
        let imageCount = await this.dbClient.countImagesTotal();
        log6("Image count: " + imageCount);
        let images = null;
        for (let i = 0; i < imageCount; i += 100) {
            images = await this.dbClient.lookupImagesByIndexRange(
                i,
                i + 100,
                { processed: true, enabled: true },
                { downloaded: true, enabled: true },
                { do_not_download: false, enabled: true }
            );
            if (images === undefined) continue;
            if (images === null) continue;
            for (const element of images) {
                let image = element;
                if (image === undefined) continue;
                if (image === null) continue;
                if (image.downloaded !== true) {
                    log6(
                        "Image not downloaded. Skipping. Image: " +
                            JSON.stringify(image)
                    );
                    continue;
                }
                if (
                    this.checkFileExistsPath(image.storage_location) === false
                ) {
                    image = new ImageInfo(
                        image.parent_uuid,
                        image.grid_index,
                        image.enqueue_time,
                        image.full_command,
                        image.width,
                        image.height
                    );
                    image.downloaded = false;
                    image.processed = true;
                    image.storageLocation = "";
                    log6(
                        "Image file does not exist. Updating database. Image: " +
                            JSON.stringify(image)
                    );
                    await this.dbClient.updateImage(image);
                    log6("Done updating database");
                }
            }
        }
        this.verifyDownloadsInProgress = false;
        log6("DownloadManager.verifyDownloads() complete");
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
        let timeToUpscale = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            this.timeToUpscale / 60,
            this.timeToUpscale % 60,
            0,
            0
        );
        let timeUntilUpscale = timeToUpscale - now;
        if (timeUntilUpscale < 0) timeUntilUpscale += 1000 * 60 * 60 * 24;
        this.runTimeout = setTimeout(() => this.run(), timeUntilUpscale);
    }

    async run() {
        log5("UpscaleManager.run() called");
        if (!this.runEnabled) {
            log1(
                "UpscaleManager.run() warning: Run is disabled. Run will not start."
            );
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
            this.systemLogger.log(
                "One or more errors occurred while upscaling images"
            );
        }
        this.checkForFinishedJobs();
        this.start();
    }

    async lookupAndUpscaleImageByIndex(index) {
        log5("UpscaleManager.lookupAndUpscaleImageByIndex() called");
        if (!this.runEnabled) {
            log1(
                "UpscaleManager.lookupAndUpscaleImageByIndex() warning: Run is disabled."
            );
            return true;
        }
        let image = await this.dbClient.lookupImageByIndex(
            index,
            { processed: true, enabled: true },
            { downloaded: true, enabled: true },
            { do_not_download: false, enabled: true }
        );
        if (image === undefined) return true;
        if (image === null) return true;
        // image = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height, image.storage_location);
        this.queueImage(image);
    }

    queueImage(image) {
        log5("UpscaleManager.queueImage() called");
        // console.log("Upscailing image");
        // get folder name from image.storageLocation
        if (image.storage_location.includes("\\"))
            image.storage_location = image.storage_location.replaceAll(
                "\\",
                "/"
            );
        let folder = image.storage_location.substring(
            0,
            image.storage_location.lastIndexOf("/")
        );
        // console.log("folder: " + folder);
        let destFolder = path.join(folder, "upscaled");
        // console.log("destFolder: " + destFolder);
        if (!fs.existsSync(destFolder)) {
            log1(
                "UpscaleManager.queueImage() warning: Destination folder does not exist. Creating it now. Folder: " +
                    destFolder
            );
            // console.log("Creating folder: " + destFolder);
            fs.mkdirSync(destFolder, { recursive: true });
        }
        let destFileName = image.storage_location.split("/").pop();
        // console.log("destFileName: " + destFileName);
        destFileName =
            destFileName.substring(0, destFileName.lastIndexOf(".")) +
            "-upscaled.jpg";
        // console.log("destFileName: " + destFileName);
        image.upscale_location = path.join(destFolder, destFileName);
        // console.log("image.upscale_location: " + image.upscale_location);
        this.upscaler
            .upscale(
                image.storage_location
                    .replaceAll("\\", "/")
                    .replaceAll("\\\\", "/"),
                destFolder.replaceAll("\\", "/").replaceAll("\\\\", "/")
            )
            .then((jobID) => {
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
const downloadManager = new DownloadManager(
    imageDB,
    systemLogger,
    upscalerManager
);

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

const databaseUpdateManager = new DatabaseUpdateManager(
    imageDB,
    systemLogger,
    puppeteerClient
);
const serverStatusMonitor = new ServerStatusMonitor(
    systemLogger,
    puppeteerClient,
    downloadManager,
    imageDB,
    upscalerManager,
    databaseUpdateManager
);

if (!loadSettings()) {
    systemLogger?.log(
        "Settings file not found. Using default settings",
        new Date().toLocaleString()
    );
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
app.use(express.static("./"));
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

/****************************************************************************************
 * Server endpoints
 */
/**
 * GET /
 * Home page
 */
app.get("/", (req, res) => {
    log3("GET /");
    res.render("index");
});

/**
 * GET /images
 * Images page for viewing images and selecting them for download
 */
app.get("/images", (req, res) => {
    log3("GET /images");
    res.render("images");
});

app.get("/tools", (req, res) => {
    log3("GET /tools");
    res.render("tools");
});

/**
 * GET /updateDB
 * Endpoint for triggering an update of the database with the latest jobs from Midjourney
 * @returns {string} - "ok" once the update has been triggered
 */
app.get("/updateDB", async (req, res) => {
    log3("GET /updateDB");
    databaseUpdateManager.run();
    res.send("ok");
});

/**
 * GET /show
 * Shows a slideshow of images from the database
 */
app.get("/show", (req, res) => {
    log3("GET /show");
    res.render("show");
});

/**
 * GET /show/:uuid
 * Shows a single image from the database
 * @param {string} uuid - the uuid of the image to show
 * @returns {string} - html that shows the image and is a link to another random image. JSON is also embedded in the html.
 */
app.get("/show/:uuid", async (req, res) => {
    log3("GET /show/:uuid");
    const { uuid } = req.params;
    if (uuid === "" || uuid === undefined) {
        log6("uuid is empty or undefined. Rendering show.ejs");
        res.render("show");
    } else {
        log4("looking up uuid: ", uuid);
        const image = await imageDB.lookupByUUID(uuid);
        log6("got image from DB. Converting to ImageInfo object");
        const imageInfo = new ImageInfo(
            image.parent_uuid,
            image.grid_index,
            image.enqueue_time,
            image.full_command,
            image.width,
            image.height,
            image.storage_location,
            image.upscale_location
        );
        log6("updating times selected");
        imageDB.updateTimesSelectedPlusOne(uuid);
        log6("Sending html with image and json embedded");
        res.send(
            `<a href="/randomUUID"><img src="${
                imageInfo.urlFull
            }" /></a><script type="application/json">${JSON.stringify(
                imageInfo
            )}</script>`
        );
    }
});

/**
 * GET /randomUUID
 * Redirects to a random image
 */
app.get("/randomUUID/:dlOnly", async (req, res) => {
    log3("GET /randomUUID");
    const { dlOnly } = req.params;
    log6("dlOnly: " + dlOnly);
    let _dlOnly;
    if (dlOnly === "true") _dlOnly = true;
    else _dlOnly = false;
    log6("_dlOnly: " + _dlOnly);
    let imageInfo = null;
    log6("Getting random image");
    do {
        imageInfo = await imageDB.getRandomImage(_dlOnly);
    } while (imageInfo === undefined || imageInfo === null);
    log6("Got random image");
    log6("Redirecting to /show/" + imageInfo.uuid);
    res.redirect(`/show/${imageInfo.uuid}`);
});

app.get("/randomUUID", async (req, res) => {
    log3("GET /randomUUID");
    res.redirect(`/randomUUID/false`);
});

/**
 * GET /available-folders
 * Gets a list of folders in the working directory
 */
app.get("/available-folders", (req, res) => {
    log3("GET /available-folders");
    const folders = fs
        .readdirSync("./")
        .filter((file) => fs.lstatSync(path.join("./", file)).isDirectory());
    log6("Folders: " + folders);
    res.json(folders);
});

/**
 * GET /set-download-location/:location
 * Sets the download location for the download manager
 */
app.get("/set-download-location/:location", (req, res) => {
    log3("GET /set-download-location/:location");
    const { location } = req.params;
    log6("location: " + location);
    const success = downloadManager.setDownloadLocation(location);
    log6("success: " + success);
    res.json(success);
});

/**
 * GET /set-time-to-download/:time
 * Sets the time to download for the download manager
 */
app.get("/set-time-to-download/:time", (req, res) => {
    log3("GET /set-time-to-download/:time");
    const { time } = req.params;
    log6("time: " + time);
    const success = downloadManager.setTimeToDownload(time);
    res.json(success);
});

/**
 * GET /set-run-enabled/:enabled
 * Sets whether or not the download manager should run
 */
app.get("/set-run-enabled/:dl/:db/:up", (req, res) => {
    log3("GET /set-run-enabled/:dl/:db/:up");
    const { dl, db, up } = req.params;
    downloadManager.downloadRunEnabled = dl === "true";
    databaseUpdateManager.runEnabled = db === "true";
    upscalerManager.runEnabled = up === "true";

    settings.dbUpdateRunEnabled = db === "true";
    settings.downloadRunEnabled = dl === "true";
    settings.upscaleRunEnabled = up === "true";

    log6("downloadRunEnabled: " + downloadManager.downloadRunEnabled);
    log6("dbUpdateRunEnabled: " + databaseUpdateManager.runEnabled);
    log6("upscaleRunEnabled: " + upscalerManager.runEnabled);

    res.json({
        downloadRunEnabled: downloadManager.downloadRunEnabled,
        dbUpdateRunEnabled: databaseUpdateManager.runEnabled,
        upscaleRunEnabled: upscalerManager.runEnabled,
    });
});

/**
 * GET /loggerGet/:entries/:remove
 * Gets the most recent entries from the logger
 * @param {number} entries - the number of entries to get
 * @param {boolean} remove - whether or not to remove the entries from the logger
 * @returns {json} - the entries from the logger
 */
app.get("/loggerGet/:entries/:remove", (req, res) => {
    log3("GET /loggerGet/:entries/:remove");
    const { entries, remove } = req.params;
    log6("entries: " + entries);
    log6("remove: " + remove);
    if (remove === "true") log2("removing entries from log");
    let log = systemLogger.getRecentEntries(entries, remove === "true");
    log6("log: " + log);
    res.json(log);
});

/**
 * GET /loggerDelete/:id
 * Deletes an entry from the logger
 * @param {number} id - the id of the entry to delete
 */
app.get("/loggerDelete/:id", (req, res) => {
    log3("GET /loggerDelete/:id");
    const { id } = req.params;
    log6("id: " + id);
    const success = systemLogger.deleteEntry(id);
    res.json(success);
});

/**
 * POST /logger
 * Endpoint for logging messages to the logger
 * @param {string} message - the message to log *
 */
app.post("/logger", (req, res) => {
    log3("POST /logger");
    const { message } = req.body;
    log6("message: " + message);
    systemLogger.log(message);
    res.send("ok");
});

app.get("/image/recent/:limit/:offset", async (req, res) => {
    log3("GET /image/recent/:limit/:offset");
    const { limit, offset } = req.params;
    log6("limit: " + limit);
    log6("offset: " + offset);
    const data = await imageDB.getEntriesOrderedByEnqueueTime(limit, offset);
    res.json(data);
});

app.get("/image/update/:id/:do_not_download", async (req, res) => {
    log3("GET /image/update/:id/:do_not_download");
    const { id, do_not_download } = req.params;
    log6("id: " + id);
    log6("do_not_download: " + do_not_download);
    let image = await imageDB.lookupByUUID(id);
    if (image === undefined) {
        res.status(404).send("Image not found");
        return;
    }
    const imageInfo = new ImageInfo(
        image.parent_uuid,
        image.grid_index,
        image.enqueue_time,
        image.full_command,
        image.width,
        image.height
    );
    imageInfo.doNotDownload = do_not_download === "true";
    imageInfo.processed = true;
    await imageDB.updateImage(imageInfo);
    res.json(imageInfo);
});

/**
 * GET /image/:imageUuid
 * Endpoint for getting an image from the database
 * @param {string} imageUuid - the uuid of the image to get
 * @param {number} width - the width to resize the image to
 * @param {number} height - the height to resize the image to
 * @returns {image} - the image
 */
app.get("/image/:imageUuid", async (req, res) => {
    log3("GET /image/:imageUuid");
    const { imageUuid } = req.params;
    const { width, height } = req.query;
    log6("imageUuid: " + imageUuid);
    log6("width: " + width);
    log6("height: " + height);

    const imagePath = path.join(__dirname, "output/all", imageUuid);
    log6("imagePath: " + imagePath);

    // Ensure the file exists
    if (!fs.existsSync(imagePath)) {
        res.status(404).send("Image not found");
        log6("Image not found");
        return;
    }
    try {
        log6("Validating PNG");
        const image = sharp(imagePath);

        image.on("error", (error) => {
            console.error("Error processing image: ", { error });
            res.status(500).send("Server error");
        });

        // Resize the image if width or height are provided
        if (width || height) {
            const widthNum = width ? parseInt(width, 10) : null;
            const heightNum = height ? parseInt(height, 10) : null;
            image.resize(widthNum, heightNum, { fit: "inside" });
        }

        // Output the image
        res.set("Content-Type", "image/jpg");
        image.pipe(res);
    } catch (error) {
        console.error("Error processing image: ", { error });
        res.status(500).send("Server error");
    }
});

/**
 * GET /status
 * Endpoint for getting the status of the server
 * @returns {json} - the status of the server
 */
app.get("/status", async (req, res) => {
    log3("GET /status");
    res.json(await serverStatusMonitor.checkServerStatus());
});

app.get("/downloadRun", async (req, res) => {
    log3("GET /downloadRun");
    res.send("ok");
    await downloadManager.run();
});

app.get("/upscaleRun", async (req, res) => {
    log3("GET /upscaleRun");
    res.send("ok");
    await upscalerManager.run();
});

app.get("/resetSelectCount", async (req, res) => {
    log3("GET /resetSelectCount");
    res.send("ok");
    await imageDB.setAllImagesSelectedCountZero();
});

app.get("/saveSettings", async (req, res) => {
    log3("GET /saveSettings");
    res.send("ok");
    saveSettings();
});

let restartShow = false;

app.get("/showOptions", async (req, res) => {
    log3("GET /showOptions");
    res.json({
        enableAutoAdjustUpdateInterval: false,
        updateInterval: 12,
        fadeDuration: 3.4,
        timeToRestart: 60,
        timeToRestartEnabled: true,
        showPrompt: false,
        restartShow: restartShow,
    });
    restartShow = false;
});

app.get("/restartShow", async (req, res) => {
    log3("GET /restartShow");
    res.send("ok");
    restartShow = true;
});

////////////////////////////////////////////////////////////////////////////////////////
/////  Utilities
////////////////////////////////////////////////////////////////////////////////////////

function validatePNG(imagePath) {
    log5("validatePNG() called");
    return new Promise((resolve) => {
        fs.createReadStream(imagePath)
            .pipe(new PNG())
            .on("parsed", function () {
                resolve(true); // Valid PNG
            })
            .on("error", function (error) {
                // console.error('Invalid PNG:', error);
                resolve(false); // Invalid PNG
            });
    });
}

function buildImageData(data) {
    log5("buildImageData() called");
    log6("buildImageData()\ndata.length: " + data.length);
    let imageData = [];
    data.forEach((job) => {
        if (job.batch_size == 4) {
            for (let i = 0; i < 4; i++) {
                imageData.push(
                    new ImageInfo(
                        job.id,
                        i,
                        job.enqueue_time,
                        job.full_command,
                        job.width,
                        job.height
                    )
                );
            }
        } else {
            imageData.push(
                new ImageInfo(
                    job.parent_id,
                    job.parent_grid,
                    job.enqueue_time,
                    job.full_command,
                    job.width,
                    job.height
                )
            );
        }
    });
    return imageData;
}

function waitSeconds(seconds) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, seconds * 1000);
    });
}

function loadSettings() {
    log5("loadSettings() called");
    if (fs.existsSync("settings.json")) {
        try {
            settings = JSON.parse(fs.readFileSync("settings.json"));
            return true;
        } catch (err) {
            log0(["loadSettings() error: Error loading settings file", err]);
            return false;
        }
    } else {
        return false;
    }
}

function saveSettings() {
    log5("saveSettings() called");
    fs.writeFileSync("settings.json", JSON.stringify(settings, null, 4));
    systemLogger?.log("Setting saved", new Date().toLocaleString());
}

systemLogger.log("Server started", new Date().toLocaleString());

process.on("exit", (code) => {
    saveSettings();
    log2("exiting");
    imageDB.dbClient.end();
    systemLogger?.log("Server exited", new Date().toLocaleString());
});
