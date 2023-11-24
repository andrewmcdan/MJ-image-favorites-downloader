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
 * 1. update the database so that it holds all the data that the ImageInfo class holds
 * 2. make it so that the server runs puppeteer instead of using the browser extension
 *      - this will allow the server to pull down the metadata on a regular basis, like at night
 * 
 * 
 * 
 * 
 * 
 * 
 * //////////////// NEED to evaluate these TODO's ////////////////
 * 1. Add ExifTool capability to add metadata to images
 * 2. Add upscale capability to images using Ai-Upscale-Module
 * 3. Parse the output folder and omit images that have already been processed
 *      - This will require a database to store the image names, possibly just a json file
 * 4. add a page of general tools. ie. revering an image uuid to the original prompt / user (url, name, etc.)
 */
//
const fs = require('fs');
// const axios = require('axios');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const PNG = require('pngjs').PNG;
const app = express();
const port = 3001;
app.use(bodyParser.json({ limit: '100mb' }));
const pgClient = require('pg');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const Upscaler = require('ai-upscale-module');

let updateDB = true;

let settings = {};

class DB_Error extends Error {
    static count = 0;
    constructor(message) {
        super(message);
        this.name = "DB_Error";
        Error.captureStackTrace?.(this, DB_Error);
        systemLogger?.log("DB_Error", message);
        DB_Error.count++;
    }
}

class SystemLogger {
    constructor() {
        this.logArr = [];
        this.idIndex = 0;
    }

    log(...message) {
        let entry = {};
        entry.time = new Date();
        entry.message = message;
        entry.id = this.idIndex++;
        this.logArr.push(entry);
    }

    getLog() {
        return this.logArr;
    }

    clearLog() {
        this.logArr = [];
    }

    printLog() {
        console.log(this.logArr);
    }

    printLogToFile() {
        // serialize the log
        console.log("Not implemented");
        // fs.writeFileSync('log.txt', this.log);
    }

    getMostRecentLog(remove = false) {
        if (this.logArr.length === 0) return null;
        let logTemp = this.logArr[this.logArr.length - 1];
        if (remove) {
            this.logArr.pop();
        }
        return logTemp;
    }

    getRecentEntries(numberOfEntries, remove = false) {
        let entries = [];
        if (typeof numberOfEntries === "string") numberOfEntries = parseInt(numberOfEntries);
        numberOfEntries = Math.min(numberOfEntries, this.logArr.length);
        if (remove) {
            for (let i = 0; i < numberOfEntries; i++) {
                entries.push(this.getMostRecentLog(remove));
            }
        } else {
            for (let i = 0; i < numberOfEntries; i++) {
                entries.push(this.logArr[this.logArr.length - 1 - i]);
            }
        }
        return entries;
    }

    deleteEntry(id) {
        if (typeof id === "string") id = parseInt(id);
        for (let i = 0; i < this.logArr.length; i++) {
            if (this.logArr[i].id === id) {
                this.logArr.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    getNumberOfEntries() {
        return this.logArr.length;
    }
};

class PuppeteerClient {
    constructor() {
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
    }

    async loadSession() {
        return new Promise(async (resolve, reject) => {
            if (fs.existsSync('mjSession.json') && fs.existsSync('discordSession.json')) {
                let sessionData = JSON.parse(fs.readFileSync('mjSession.json'));
                this.mj_cookies = sessionData.cookies;
                this.mj_localStorage = sessionData.localStorage;
                this.mj_sessionStorage = sessionData.sessionStorage;
                sessionData = JSON.parse(fs.readFileSync('discordSession.json'));
                this.discord_cookies = sessionData.cookies;
                this.discord_localStorage = sessionData.localStorage;
                this.discord_sessionStorage = sessionData.sessionStorage;
            } else {
                reject("Session file not found");
                return;
            }

            if (this.browser == null) {
                this.browser = await puppeteer.launch({ headless: 'new', defaultViewport: null, args: ['--start-maximized'] });
                this.page = (await this.browser.pages())[0];
            }

            await this.page.goto('https://www.midjourney.com/home', { waitUntil: 'networkidle2', timeout: 60000 });
            let discordPage = await this.browser.newPage();
            await discordPage.goto('https://discord.com/');
            // await waitSeconds(1);
            await this.page.setCookie(...this.mj_cookies);
            await discordPage.setCookie(...this.discord_cookies);
            // await waitSeconds(1);
            await discordPage?.close();

            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });
            // await waitSeconds(2);
            if (this.page.url().includes("https://www.midjourney.com/imagine")) {
                this.loggedIntoMJ = true;
                resolve();
            } else {
                this.loggedIntoMJ = false;
                reject("Session restore failed");
            }
        });
    }

    async loginToMJ(credentials_cb) {
        return new Promise(async (resolve, reject) => {
            if ((!this.loggedIntoMJ || this.browser == null) && !this.loginInProgress) {
                // attempt to restore session
                this.loadSession().then(() => { resolve(); }).catch(async () => {
                    this.loginInProgress = true;
                    if (this.browser !== null) await this.browser.close();
                    this.browser = await puppeteer.launch({ headless: 'new', defaultViewport: null, args: [
                        '--enable-javascript',
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        '--user-agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36"',] });
                    this.page = (await this.browser.pages())[0];

                    this.browser.on('targetcreated', async (target) => {
                        const pageList = await this.browser.pages();
                        let discordLoginPage = pageList[pageList.length - 1];
                        if (discordLoginPage.url().includes("discord.com/login")) {
                            await this.loginToDiscord(discordLoginPage, credentials_cb);
                        }
                    });

                    await this.page.goto('https://www.midjourney.com/home', { waitUntil: 'networkidle2', timeout: 60000 });
                    let html = await this.page.content();
                    console.log(html);
                    // await waitSeconds(5);
                    await this.page.mouse.move(0, 0);
                    await this.page.mouse.move(100, 100);
                    await this.page.mouse.wheel({ deltaY: 100 });
                    await waitSeconds(1);
                    await this.page.mouse.wheel({ deltaY: -200 });
                    await waitSeconds(1);
                    await this.page.click('span ::-p-text(Sign In)').catch(() => { reject("Sign In button not found");});
                    // await waitSeconds(1);
                    let waitCount = 0;
                    while (!this.discordLoginComplete) {
                        await waitSeconds(1);
                        waitCount++;
                        if (waitCount > 120) {
                            reject("Timed out waiting for login");
                        }
                    }
                    this.loginInProgress = false;
                    await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });
                    await waitSeconds(5);
                    this.pageURL = this.page.url();
                    if (this.pageURL.includes("imagine") || this.pageURL.includes("explore")) {
                        this.loggedIntoMJ = true;
                        this.mj_cookies = await this.page.cookies();
                        this.mj_localStorage = await this.page.evaluate(() => { return window.localStorage; });
                        this.mj_sessionStorage = await this.page.evaluate(() => { return window.sessionStorage; });
                        fs.writeFileSync('mjSession.json', JSON.stringify({ cookies: this.mj_cookies, localStorage: this.mj_localStorage, sessionStorage: this.mj_sessionStorage }));

                        let discordPage = await this.browser.newPage();
                        await discordPage.goto('https://discord.com/channels/@me');
                        await waitSeconds(2);
                        this.discord_cookies = await discordPage.cookies();
                        this.discord_localStorage = await discordPage.evaluate(() => { return window.localStorage; });
                        this.discord_sessionStorage = await discordPage.evaluate(() => { return window.sessionStorage; });
                        fs.writeFileSync('discordSession.json', JSON.stringify({ cookies: this.discord_cookies, localStorage: this.discord_localStorage, sessionStorage: this.discord_sessionStorage }));
                        await waitSeconds(15);
                        await discordPage?.close();
                        resolve();
                    } else {
                        this.loggedIntoMJ = false;
                        reject("Login failed");
                    }
                });
                if (this.loggedIntoMJ) {
                    await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });
                    resolve();
                }
            }
        });
    }

    async loginToDiscord(discordLoginPage, credentials_cb) {
        let credentials = await credentials_cb();
        let username = credentials.uName;
        let password = credentials.pWord;
        let MFA_cb = credentials.mfaCb;
        await waitSeconds(1);
        await discordLoginPage.waitForSelector('input[name="email"]');
        let typingRandomTimeMin = 0.03;
        let typingRandomTimeMax = 0.15;
        for (let i = 0; i < username.length; i++) {
            await discordLoginPage.type('input[name="email"]', username.charAt(i));
            let randomTime = Math.random() * (typingRandomTimeMin) + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }

        await discordLoginPage.keyboard.press('Tab');
        for (let i = 0; i < password.length; i++) {
            await discordLoginPage.type('input[name="password"]', password.charAt(i));
            let randomTime = Math.random() * (typingRandomTimeMin) + typingRandomTimeMax;
            await waitSeconds(randomTime);
        }

        await waitSeconds(1);
        await discordLoginPage.click('button[type="submit"]');
        discordLoginPage.waitForSelector('input[placeholder="6-digit authentication code"]', { timeout: 60000 }).then(async () => {
            let data = "";
            if (MFA_cb !== null) {
                data = await MFA_cb();
            }
            await discordLoginPage.type('input[placeholder="6-digit authentication code"]', data.toString());
            await discordLoginPage.click('button[type="submit"]');
            await waitSeconds(3);
            // await discordLoginPage.waitForNavigation({ waitUntil: 'networkidle2' });
            await discordLoginPage.waitForSelector('button ::-p-text(Authorize)', { timeout: 60000 });
            await discordLoginPage.click('button ::-p-text(Authorize)');
            await waitSeconds(3);
            // await discordLoginPage.waitForNavigation({ waitUntil: 'networkidle2' });
            this.discordLoginComplete = true;
        }).catch(() => {
            this.discordLoginComplete = true;
        });

    }

    getUsersJobsData() {
        return new Promise(async (resolve, reject) => {
            if (!this.loggedIntoMJ) {
                let uNamePWordCb = async () => {
                    systemLogger.log("Not logged into MJ. Please send login credentials.");
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
                    app.get('/login/:username/:password', async (req, res) => {
                        const { username, password } = req.params;
                        uName = username;
                        pWord = password;
                        mfaCb = async () => {
                            systemLogger.log("MFA code requested. Please send MFA code.");
                            let retData = "";
                            /**
                             * GET /mfa/:data
                             * Endpoint for getting the MFA code from the user
                             * @param {string} data - the MFA code
                             * @returns {string} - the MFA code
                             */
                            app.get('/mfa/:data', (req, res) => {
                                const { data } = req.params;
                                res.send(data);
                                retData = data;
                            });
                            while (retData == "") await waitSeconds(1);
                            return retData;
                        };
                        res.send("ok");
                    });
                    while (uName == "" || pWord == "") await waitSeconds(1);
                    return { uName, pWord, mfaCb };
                }
                await this.loginToMJ(uNamePWordCb).catch((err) => {
                    reject("Not logged into MJ. Error: " + err);
                });
            }
            let waitCount = 0;
            while (this.loginInProgress) {
                await waitSeconds(1);
                waitCount++;
                if (waitCount > 60 * 5) {
                    reject("Login in progress for too long");
                }
            }
            this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 }).then(async () => {
                let data = await this.page.evaluate(async () => {
                    const getUserUUID = async () => {
                        let homePage = await fetch("https://www.midjourney.com/imagine");
                        let homePageText = await homePage.text();
                        let nextDataIndex = homePageText.indexOf("__NEXT_DATA__");
                        let nextData = homePageText.substring(nextDataIndex);
                        let startOfScript = nextData.indexOf("json\">");
                        let endOfScript = nextData.indexOf("</script>");
                        let script = nextData.substring(startOfScript + 6, endOfScript);
                        let json = script.substring(script.indexOf("{"), script.lastIndexOf("}") + 1);
                        let data = JSON.parse(json);
                        imagineProps = data.props;
                        let userUUID = data.props.initialAuthUser.midjourney_id;
                        return userUUID;
                    }
                    let userUUID = await getUserUUID();
                    let numberOfJobsReturned = 0;
                    let cursor = "";
                    let loopCount = 0;
                    let returnedData = [];
                    do {
                        // let response = await fetch("https://www.midjourney.com/api/pg/thomas-jobs?user_id=" + userUUID + "&page_size=10000" + (cursor == "" ? "" : "&cursor=" + cursor));

                        let response = await fetch("https://www.midjourney.com/api/pg/thomas-jobs?user_id=" + userUUID + "&page_size=10000" + (cursor == "" ? "" : "&cursor=" + cursor), {
                            "headers": {
                                "accept": "*/*",
                                "accept-language": "en-US,en;q=0.9",
                                "cache-control": "no-cache",
                                "content-type": "application/json",
                                "pragma": "no-cache",
                                "sec-ch-ua": "\"Chromium\";v=\"118\", \"Google Chrome\";v=\"118\", \"Not=A?Brand\";v=\"99\"",
                                "sec-ch-ua-mobile": "?0",
                                "sec-ch-ua-platform": "\"Windows\"",
                                "sec-fetch-dest": "empty",
                                "sec-fetch-mode": "cors",
                                "sec-fetch-site": "same-origin",
                                "x-csrf-protection": "1"
                            },
                            "referrer": "https://www.midjourney.com/imagine",
                            "referrerPolicy": "origin-when-cross-origin",
                            "body": null,
                            "method": "GET",
                            "mode": "cors",
                            "credentials": "include"
                        });


                        let data = await response.json();
                        // console.log({data});
                        if (data.data.length == 0) break;
                        numberOfJobsReturned = data.data.length;
                        // put all the returned data into the returnedData array
                        returnedData.push(...(data.data));
                        cursor = data.cursor;
                        loopCount++;
                        if (loopCount > 100) break; // if we've returned more than 1,000,000 jobs, there's probably something wrong, and there's gonna be problems
                    } while (numberOfJobsReturned == 10000)
                    return returnedData;
                });
                resolve(data);
            });
        });
    }

    getSingleJobStatus(jobID) {
        return new Promise(async (resolve, reject) => {
            if (!this.loggedIntoMJ) reject("Not logged into MJ");
            if (this.loginInProgress) reject("Login in progress");
            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });

            let data = await this.page.evaluate(async (jobID) => {
                let res1 = await fetch("https://www.midjourney.com/api/app/job-status", {
                    "headers": {
                        "accept": "*/*",
                        "accept-language": "en-US,en;q=0.9",
                        "content-type": "application/json",
                        "sec-ch-ua": "\"Google Chrome\";v=\"119\", \"Chromium\";v=\"119\", \"Not?A_Brand\";v=\"24\"",
                        "sec-ch-ua-mobile": "?0",
                        "sec-ch-ua-platform": "\"Windows\"",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-origin",
                        "x-csrf-protection": "1",
                        "Referer": "https://www.midjourney.com/imagine",
                        "Referrer-Policy": "origin-when-cross-origin"
                    },
                    "body": "{\"jobIds\":[\"" + jobID + "\"]}",
                    "method": "POST"
                });
                let res2 = await res1.json();
                if (res2.length > 0) return res2[0];
                else return null;
            }, jobID);
            resolve(data);
        });
    }
};

class ServerStatusMonitor {
    constructor(SystemLogger, PuppeteerClient, DownloadManager, DatabaseManager, UpscaleManager, DatabaseUpdateManager) {
        this.systemLogger = SystemLogger;
        this.puppeteerClient = PuppeteerClient;
        this.downloadManager = DownloadManager;
        this.dbClient = DatabaseManager;
        this.upscalerManager = UpscaleManager;
        this.databaseUpdateManager = DatabaseUpdateManager;
        this.serverStartTime = new Date();
    }

    async checkServerStatus() {
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
        status.upTimeFormatted = ((upTimeDays > 0) ? upTimeDays + " days, " : "") + ((upTimeHours > 0) ? upTimeHours + " hours, " : "") + ((upTimeMinutes > 0) ? upTimeMinutes + " minutes, " : "") + upTimeSeconds + " seconds";

        status.numberOfLogEntries = this.systemLogger.getNumberOfEntries();

        status.database = {};
        status.database.numberOfImages = await this.dbClient.countImagesTotal();
        status.database.errorCount = DB_Error.count;

        status.puppeteerClient = {};
        status.puppeteerClient.loggedIntoMJ = this.puppeteerClient.loggedIntoMJ;
        status.puppeteerClient.loginInProgress = this.puppeteerClient.loginInProgress;

        status.downloadManager = {};
        status.downloadManager.downloadsInProgress = this.downloadManager.concurrentDownloads;
        status.downloadManager.timeToDownload = this.downloadManager.timeToDownload;
        status.downloadManager.runEnabled = this.downloadManager.runEnabled;
        status.downloadManager.downloadLocation = this.downloadManager.downloadLocation;

        status.upscalerManager = {};
        status.upscalerManager.upscaleInProgress = this.upscalerManager.upscaleInProgress;
        status.upscalerManager.runningUpscales = this.upscalerManager.runningUpscales;
        status.upscalerManager.queuedUpscales = this.upscalerManager.queuedUpscales;

        status.databaseUpdateManager = {};
        status.databaseUpdateManager.updateInProgress = this.databaseUpdateManager.updateInProgress;
        status.databaseUpdateManager.timeToUpdate = this.databaseUpdateManager.timeToUpdate;
        status.databaseUpdateManager.runEnabled = this.databaseUpdateManager.runEnabled;

        return status;
    }
};

class Database {
    static DB_connected = false;
    constructor() {
        this.dbClient = new pgClient.Client({
            user: 'mjuser',
            host: 'postgresql.lan',
            database: 'mjimages',
            password: 'mjImagesPassword',
            port: 5432,
        });
        this.dbClient.connect().then(() => { console.log("Connected to database"); Database.DB_connected = true; }).catch((err) => { console.log("Error connecting to database:\n", err) });
        this.dbClient.on('error', (err) => {
            new DB_Error("Database error: " + err);
            if (typeof err === 'string' && err.includes("Connection terminated unexpectedly")) this.dbClient.connect();
        });
    }

    insertImage = async (image, index) => {
        // find if image exists in database
        // if it does, update it
        if (await this.lookupByUUID(image.id) !== undefined) {
            await this.updateImage(image);
            return;
        }
        // if it doesn't, insert it
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
                    image.downloaded !== null && image.downloaded !== undefined ? image.downloaded : false,
                    image.doNotDownload !== null && image.doNotDownload !== undefined ? image.doNotDownload : false,
                    image.processed !== null && image.processed !== undefined ? image.processed : false,
                    index
                ]
            );
        } catch (err) {
            new DB_Error("Error inserting image into database. Image ID: " + image.id + "Error: " + err);
            return null;
        }
        return res;
    }

    lookupByUUID = async (uuid) => {
        try {
            const res = await this.dbClient.query(
                `SELECT * FROM images WHERE uuid = $1`,
                [uuid]
            );

            if (res.rows.length > 0) {
                return res.rows[0];
            }
            return undefined;
        } catch (err) {
            new DB_Error("Error looking up image in database. Image ID: " + uuid);
            return null;
        }
    }
    getRandomImage = async (downloadedOnly = false) => {
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
            if (res.rows.length > 0) {
                return res.rows[0];
            }
            return undefined;
        } catch (err) {
            new DB_Error("Error looking up random image in database");
            return null;
        }
    }
    lookupImageByIndex = async (index, processedOnly = { processed: false, enabled: false }, downloadedOnly = { downloaded: false, enabled: false }, do_not_downloadOnly = { do_not_download: false, enabled: false }) => {
        if (typeof index === 'number') index = index.toString();
        if (typeof index === "string") {
            try {
                index = parseInt(index);
            } catch {
                return null;
            }
            index = index.toString();
        } else {
            return null;
        }
        // at this point index should be a string that is a number. Anything else would have returned null
        try {
            let queryParts = ['SELECT * FROM images WHERE id = $1'];
            let queryParams = [index];

            if (processedOnly.enabled === true) {
                queryParts.push("AND processed = " + (processedOnly.processed === true ? "true" : "false"));
            }
            if (downloadedOnly.enabled === true) {
                queryParts.push("AND downloaded = " + (downloadedOnly.downloaded === true ? "true" : "false"));
            }
            if (do_not_downloadOnly.enabled === true) {
                queryParts.push("AND do_not_download = " + (do_not_downloadOnly.do_not_download === true ? "true" : "false"));
            }

            queryParts.push("LIMIT 1");

            // console.log(queryParts.join(' '), queryParams); // TODO: remove this

            const res = await this.dbClient.query(queryParts.join(' '), queryParams);
            if (res.rows.length == 1) {
                return res.rows[0];
            } else if (res.rows.length > 1) {
                new DB_Error("Error looking up image in database. Too many rows returned. Image index: " + index);
            } else if (res.rows.length == 0) {
                return undefined;
            }
            return undefined;
        } catch (err) {
            new DB_Error("Error looking up image in database. Image index: " + index);
            return null;
        }
    }
    updateImage = async (image) => {
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
                    image.parent_id !== null && image.parent_id !== undefined ? image.parent_id : (image.parent_uuid !== null && image.parent_uuid !== undefined ? image.parent_uuid : null),
                    image.grid_index !== null && image.grid_index !== undefined ? image.grid_index : null,
                    image.enqueue_time !== null && image.enqueue_time !== undefined ? image.enqueue_time : null,
                    image.fullCommand !== null && image.fullCommand !== undefined ? image.fullCommand : null,
                    image.width !== null && image.width !== undefined ? image.width : null,
                    image.height !== null && image.height !== undefined ? image.height : null,
                    image.storageLocation !== null && image.storageLocation !== undefined ? image.storageLocation : (image.storage_location !== null && image.storage_location !== undefined ? image.storage_location : null),
                    image.downloaded !== null && image.downloaded !== undefined ? image.downloaded : null,
                    image.doNotDownload !== null && image.doNotDownload !== undefined ? image.doNotDownload : null,
                    image.processed !== null && image.processed !== undefined ? image.processed : null,
                    image.upscale_location !== null && image.upscale_location !== undefined ? image.upscale_location : null,
                    image.id !== null && image.id !== undefined ? image.id : (image.parent_uuid !== null && image.parent_uuid !== undefined && image.grid_index !== null && image.grid_index !== undefined ? image.parent_uuid + '_' + image.grid_index : null)
                ]
            );
            return res;
        } catch (err) {
            new DB_Error("Error updating image in database. Image ID: " + image.id);
            return null;
        }
    }
    deleteImage = async (uuid) => {
        try {
            const res = await this.dbClient.query(
                `DELETE FROM images WHERE uuid = $1`,
                [uuid]
            );
            return res;
        } catch (err) {
            new DB_Error("Error deleting image from database. Image ID: " + uuid);
            return null;
        }
    }
    countImagesTotal = async () => {
        try {
            const res = await this.dbClient.query(
                `SELECT COUNT(*) FROM images`
            );
            return res.rows[0].count;
        } catch (err) {
            new DB_Error("Error counting images in database");
            return null;
        }
    }
    setImageProcessed = async (uuid, valueBool = true) => {
        if (typeof valueBool === "string") valueBool = (valueBool === "true");
        if (typeof valueBool !== "boolean") throw new Error("valueBool must be a boolean");
        try {
            const res = await this.dbClient.query(
                `UPDATE images SET processed = $1 WHERE uuid = $2`,
                [valueBool, uuid]
            );
            return res;
        } catch (err) {
            new DB_Error("Error setting image processed in database. Image ID: " + uuid);
            return null;
        }
    }
    updateTimesSelectedPlusOne = async (uuid) => {
        try {
            // get times_selected for uuid
            let res = await this.dbClient.query(
                `SELECT times_selected FROM images WHERE uuid = $1`,
                [uuid]
            );
            let timesSelected = res.rows[0].times_selected;
            // add 1 to it
            timesSelected++;
            // update times_selected for uuid
            res = await this.dbClient.query(
                `UPDATE images SET times_selected = $1 WHERE uuid = $2`,
                [timesSelected, uuid]
            );
        } catch (err) {
            new DB_Error("Error updating times_selected in database. Image ID: " + uuid);
            return null;
        }
    }

    setAllImagesSelectedCountZero = async () => {
        try {
            const res = await this.dbClient.query(
                `UPDATE images SET times_selected = 0`
            );
            return res;
        } catch (err) {
            new DB_Error("Error setting all images selected count to zero");
            return null;
        }
    }

    getEntriesOrderedByEnqueueTime = async (limit = 100, offset = 0) => {
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
            return res.rows;
        } catch (err) {
            new DB_Error("Error getting entries ordered by enqueue_time");
            return null;
        }
    }
};

class ImageInfo {
    constructor(parent_id, grid_index, enqueue_time, fullCommand, width, height, storage_location = "", upscale_location = "") {
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
        let t = { ...this };
        t.urlFull = this.urlFull;
        t.urlSmall = this.urlSmall;
        t.urlMedium = this.urlMedium;
        t.urlAlt = this.urlAlt;
        t.urlParentGrid = this.urlParentGrid;
        return t;
    }

    get id() {
        return this.parent_id + '_' + this.grid_index;
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
};

class DatabaseUpdateManager {
    constructor(DatabaseManager = null, SystemLogger = null, PuppeteerClient = null) {
        this.dbClient = DatabaseManager;
        this.puppeteerClient = PuppeteerClient;
        this.systemLogger = SystemLogger;
        this.updateInProgress = false;
        this.runTimeout = null;
        this.timeToUpdate = 0; // minutes after midnight
        this.runEnabled = true;
        this.start();
    }

    start() {
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        let timeToUpdate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToUpdate / 60, this.timeToUpdate % 60, 0, 0);
        let timeUntilUpdate = timeToUpdate - now;
        if (timeUntilUpdate < 0) timeUntilUpdate += 1000 * 60 * 60 * 24;
        this.runTimeout = setTimeout(() => this.run(), timeUntilUpdate);
    }

    run() {
        if (!this.runEnabled) {
            this.start();
            return;
        }
        if (this.updateInProgress === true) return;
        this.updateInProgress = true;
        let data;
        this.puppeteerClient.getUsersJobsData().then(async (dataTemp) => {
            data = dataTemp;
            console.log(typeof data);
            console.log("Size of data: ", data.length, "\nCalling buildImageData()");
            let imageData = buildImageData(data);
            console.log("Size of data: ", imageData.length, "\nDone building imageData\nUpdating database");
            for (let i = 0; i < imageData.length; i++) {
                if (updateDB) await imageDB.insertImage(imageData[i], i);
            }
            console.log("Done updating database");
        }).catch((err) => {
            console.log(err);
            this.systemLogger.log("Error getting user's jobs data", err);
        }).finally(() => {
            this.updateInProgress = false;
            this.start();
        });
    }
}

class DownloadManager {
    constructor(DatabaseManager = null, SystemLogger = null, UpscaleManager = null) {
        this.upscaleManager = UpscaleManager;
        this.downloadLocation = "output";
        this.timeToDownload = 0; // minutes past midnight
        this.runEnabled = false;
        this.downloadInProgress = false;
        this.concurrentDownloads = 0;
        this.runTimeout = null;
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
        this.start();
        this.verifyDownloadsInProgress = false;
    }

    setDownloadLocation(location) {
        this.downloadLocation = location;
        let stats = fs.statSync(this.downloadLocation);
        if (!stats.isDirectory()) {
            return false;
        }
        try {
            if (!fs.existsSync(this.downloadLocation)) fs.mkdirSync(this.downloadLocation, { recursive: true });
        } catch (err) {
            return false;
        }
        return true;
    }

    setTimeToDownload(time) {
        if (typeof time === "string") {
            try {
                time = parseInt(time);
            } catch {
                return false;
            }
        }
        if (typeof time !== "number") return false;
        this.timeToDownload = time;
        if (this.timeToDownload < 0) this.timeToDownload = 0;
        if (this.timeToDownload > 1440) this.timeToDownload = this.timeToDownload % 1440;
        return true;
    }

    async downloadImage(url, image) {
        let response;
        try {
            response = await fetch(url);
        } catch (err) {
            return ({ success: false, error: err });
        }

        if (!response.ok) {
            return ({ success: false, error: "Bad response code: " + response.status });
        }
        if (response.headers.get('content-type') !== "image/png") {
            return ({ success: false, error: "Bad content type: " + response.headers['content-type'] });
        }
        if (parseInt(response.headers.get('content-length'), 10) < 1000) {
            return ({ success: false, error: "Bad content length: " + response.headers['content-length'] });
        }

        let contentLength = parseInt(response.headers.get('content-length'), 10);
        let imageDate = new Date(image.enqueue_time);
        let year = imageDate.getFullYear();
        let month = imageDate.getMonth() + 1;
        let day = imageDate.getDate();
        let destFolder = this.downloadLocation + "/" + year + "/" + month + "/" + day;
        if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
        let splitImage = url.split('/');
        let destFileName = splitImage[splitImage.length - 2] + "-" + splitImage[splitImage.length - 1];

        if (fs.existsSync(path.join(destFolder, destFileName))) {
            // delete file
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
        contentLength = parseInt(contentLength);
        if (fileSize != contentLength) {
            return ({ success: false, error: "File size mismatch: " + fileSize + " != " + contentLength });
            // return; 
        }
        console.log("Downloaded image " + destFileName + " of size " + fileSize + " bytes");
        image.downloaded = true;
        image.storageLocation = path.join(destFolder, destFileName);
        image.processed = true;
        image.fileSize = fileSize;
        image.success = true;
        return (image);
    }

    start() {
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        let timeToDownload = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToDownload / 60, this.timeToDownload % 60, 0, 0);
        let timeUntilDownload = timeToDownload - now;
        if (timeUntilDownload < 0) timeUntilDownload += 1000 * 60 * 60 * 24;
        this.runTimeout = setTimeout(() => this.run(), timeUntilDownload);
    }

    async run() {
        if (!this.runEnabled) {
            this.start();
            return;
        }
        if (this.verifyDownloadsInProgress) {
            setTimeout(() => this.run(), 10000);
            return;
        }
        if (this.downloadInProgress === true) return;
        this.downloadInProgress = true;
        await this.verifyDownloads();
        this.concurrentDownloads = 0;
        let imageCount = await this.dbClient.countImagesTotal();
        console.log("Image count: " + imageCount);
        let success = true;
        for (let i = 0; i < imageCount; i++) {
            if (!(await this.lookupAndDownloadImageByIndex(i))) success = false;
        }
        if (success) {
            console.log("Done downloading images");
        } else {
            console.log("One or more errors occurred while downloading images");
            this.systemLogger.log("One or more errors occurred while downloading images");
        }
        this.downloadInProgress = false;
        this.start();
    }

    async lookupAndDownloadImageByIndex(index) {
        if (!this.runEnabled) return true;
        let image = await this.dbClient.lookupImageByIndex(index, { processed: true, enabled: true }, { downloaded: false, enabled: true }, { do_not_download: false, enabled: true });
        if (image === undefined) return true;
        if (image === null) return true;
        image = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height);

        this.concurrentDownloads++;
        let imageResult;
        try {
            imageResult = await this.downloadImage(image.urlAlt, image);
        } catch (err) {
            this.systemLogger.log("Error downloading image", err, image);
            return false;
        }
        this.concurrentDownloads--;

        if (imageResult.success === true) {
            await this.dbClient.updateImage(imageResult);
        } else {
            this.systemLogger?.log("Error downloading image", imageResult.error, image);
            let url = image.urlFull;
            if (imageResult.error.includes("File size mismatch")) {
                url = image.urlAlt;
            }
            this.concurrentDownloads++;
            let altImageResult;
            try {
                altImageResult = await this.downloadImage(url);
            } catch (err) {
                this.systemLogger.log("Error downloading image", err, image);
                return false;
            }
            this.concurrentDownloads--;
            if (altImageResult.success === true) {
                await this.dbClient.updateImage(altImageResult);
            } else {
                this.systemLogger.log("Error downloading image", altImageResult.error, image);
                return false;
            }
        }
        return true;
    }

    checkFileExistsPath(path) {
        if (typeof path !== "string") return false;
        if (path === "") return false;
        let stats;
        try {
            stats = fs.statSync(path);
        } catch (err) {
            return false;
        }
        if (stats.isFile()) return true;
        return false;
    }

    async verifyDownloads() {
        if (this.verifyDownloadsInProgress) return;
        this.verifyDownloadsInProgress = true;
        let imageCount = await this.dbClient.countImagesTotal();
        for (let i = 0; i < imageCount; i++) {
            let image = await this.dbClient.lookupImageByIndex(i, { processed: true, enabled: true }, { downloaded: true, enabled: true }, { do_not_download: false, enabled: true });
            if (image === undefined) continue;
            if (image === null) continue;
            if (image.downloaded !== true) continue;
            if (this.checkFileExistsPath(image.storage_location) === false) {
                image = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height);
                image.downloaded = false;
                image.processed = true;
                image.storageLocation = "";
                await this.dbClient.updateImage(image);
            }
        }
        this.verifyDownloadsInProgress = false;
    }
};

class UpscaleManager {
    constructor(DatabaseManager = null, SystemLogger = null) {
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
        this.queue = [];
        this.upscaler = new Upscaler({
            defaultScale: 4, // can be 2, 3, or 4
            defaultFormat: "jpg", // or "png"
            downloadProgressCallback: () => { }, // Callback that gets called twice per second while a download is in progress
            defaultModel: "ultrasharp-2.0.1", // Default model name 
            maxJobs: 2 // Max # of concurrent jobs
        });
        this.timeToUpscale = 0; // minutes past midnight
        this.runEnabled = false;
        this.runTimeout = null;
        this.upscaleRunInprogress = false;
        this.start();
    }

    start() {
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        let timeToUpscale = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToUpscale / 60, this.timeToUpscale % 60, 0, 0);
        let timeUntilUpscale = timeToUpscale - now;
        if (timeUntilUpscale < 0) timeUntilUpscale += 1000 * 60 * 60 * 24;
        this.runTimeout = setTimeout(() => this.run(), timeUntilUpscale);
    }

    async run() {
        if (!this.runEnabled) {
            this.start();
            return;
        }

        if (this.upscaleRunInprogress) return;
        this.queue = [];
        this.upscaleRunInprogress = true;
        let imageCount = await this.dbClient.countImagesTotal();
        console.log("Image count: " + imageCount);
        let success = true;
        for (let i = 0; i < imageCount; i++) {
            if (!(await this.lookupAndUpscaleImageByIndex(i))) success = false;
        }
        if (success) {
            console.log("Done upscaling images");
        } else {
            console.log("One or more errors occurred while upscaling images");
            this.systemLogger.log("One or more errors occurred while upscaling images");
        }
        this.checkForFinishedJobs();
        this.start();
    }

    async lookupAndUpscaleImageByIndex(index) {
        if (!this.runEnabled) return true;
        let image = await this.dbClient.lookupImageByIndex(index, { processed: true, enabled: true }, { downloaded: true, enabled: true }, { do_not_download: false, enabled: true });
        if (image === undefined) return true;
        if (image === null) return true;
        // image = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height, image.storage_location);
        this.queueImage(image);
    }

    queueImage(image) {
        // get folder name from image.storageLocation
        let folder = image.storage_location.substring(0, image.storage_location.lastIndexOf('\\'));
        let destFolder = path.join(folder, "upscaled");
        if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
        let destFileName = image.storage_location.split('\\').pop();
        destFileName = destFileName.substring(0, destFileName.lastIndexOf('.')) + "-upscaled.jpg";
        image.upscale_location = path.join(destFolder, destFileName);
        // console.log({ image });
        // console.log({ destFileName });
        // console.log({ destFolder });
        this.upscaler.upscale(image.storage_location.replaceAll('\\', '/').replaceAll('\\\\', '/'), destFolder.replaceAll('\\', '/').replaceAll('\\\\', '/')).then((jobID) => {
            image.jobID = jobID;
            this.queue.push(image);
            // console.log("Queued image ", { image });
        });
    }

    async checkForFinishedJobs() {
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
                console.log("Finished job: ", image.jobID);
                console.log("Image: ", image);
                // TODO: verify file exists and is valid jpg
                await this.dbClient.updateImage(image);
                this.queue = this.queue.filter((image2) => {
                    return image2.jobID !== image.jobID;
                });
            })
        })();

        await waitSeconds(30);
        this.checkForFinishedJobs();
    }

    get queuedUpscales() {
        return this.upscaler.getNumberOfWaitingJobs();
    }

    get runningUpscales() {
        return this.upscaler.getNumberOfRunningJobs();
    }

    get upscaleInProgress() {
        return this.upscaler.getNumberOfRunningJobs() > 0;
    }
};

const puppeteerClient = new PuppeteerClient();
const systemLogger = new SystemLogger();
const imageDB = new Database();
const upscalerManager = new UpscaleManager(imageDB, systemLogger);
const downloadManager = new DownloadManager(imageDB, systemLogger, upscalerManager);

(async () => {
    while (Database.DB_connected === false) {
        await waitSeconds(1);
    }
    console.log("Verifying downloads");
    await downloadManager.verifyDownloads();
    console.log("Done verifying downloads");
})()


const databaseUpdateManager = new DatabaseUpdateManager(imageDB, systemLogger, puppeteerClient);

const serverStatusMonitor = new ServerStatusMonitor(systemLogger, puppeteerClient, downloadManager, imageDB, upscalerManager, databaseUpdateManager);


if (!loadSettings()) {
    systemLogger?.log("Settings file not found. Using default settings", new Date().toLocaleString());
    settings = {
        downloadLocation: "output",
        timeToDownload: 0,
        runEnabled: false,
        updateDB: true
    };
    downloadManager?.setDownloadLocation(settings.downloadLocation);
    downloadManager?.setTimeToDownload(settings.timeToDownload);
    downloadManager.runEnabled = settings.runEnabled;
    databaseUpdateManager.runEnabled = settings.runEnabled;
    updateDB = settings.updateDB;
}

/////////////////////////////////////////////////////////////////////////////////////////
app.use(express.static('public'));
app.use(express.static('./'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));




// Start the server on port 3000 and print all the ip addresses of this server
app.listen(port, () => {
    // get this server's ip address
    const os = require('os');
    const ifaces = os.networkInterfaces();
    let ipAddresses = [];
    Object.keys(ifaces).forEach(function (ifname) {
        let alias = 0;
        ifaces[ifname].forEach(function (iface) {
            if ('IPv4' !== iface.family || iface.internal !== false) return;
            if (alias >= 1) ipAddresses.push(iface.address);
            else ipAddresses.push(iface.address);
            ++alias;
        });
    });
    ipAddresses.forEach((ip) => {
        console.log(`Server running at http://${ip}:${port}/`);
    });
});

app.set('view engine', 'ejs');

/****************************************************************************************
 * Server endpoints 
 */
/**
 * GET /
 * Home page
 */
app.get('/', (req, res) => {
    res.render('index');
});

/**
 * GET /images
 * Images page for viewing images and selecting them for download
 */
app.get('/images', (req, res) => {
    res.render('images');
});

app.get('/tools', (req, res) => {
    res.render('tools');
});



/**
 * GET /updateDB
 * Endpoint for triggering an update of the database with the latest jobs from Midjourney
 * @returns {string} - "ok" once the update has been triggered
 */
app.get('/updateDB', async (req, res) => {
    databaseUpdateManager.run();
    res.send("ok");
});

/**
 * GET /show
 * Shows a slideshow of images from the database
 */
app.get('/show', (req, res) => {
    res.render('show');
});

/**
 * GET /show/:uuid
 * Shows a single image from the database
 * @param {string} uuid - the uuid of the image to show
 * @returns {string} - html that shows the image and is a link to another random image. JSON is also embedded in the html.
 */
app.get('/show/:uuid', async (req, res) => {
    const { uuid } = req.params;
    if (uuid === "" || uuid === undefined) res.render('show');
    else {
        console.log("looking up uuid: ", uuid);
        const image = await imageDB.lookupByUUID(uuid);
        const imageInfo = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height, image.storage_location, image.upscale_location);
        imageDB.updateTimesSelectedPlusOne(uuid);
        res.send(`<a href="/randomUUID"><img src="${imageInfo.urlFull}" /></a><script type="application/json">${JSON.stringify(imageInfo)}</script>`);
    }
});

/**
 * GET /randomUUID
 * Redirects to a random image
 */
app.get('/randomUUID/:dlOnly', async (req, res) => {
    const { dlOnly } = req.params;
    let _dlOnly;
    if (dlOnly === "true") _dlOnly = true;
    else _dlOnly = false;
    let imageInfo = await imageDB.getRandomImage(_dlOnly);
    while (imageInfo === undefined || imageInfo === null) {
        imageInfo = await imageDB.getRandomImage(true);
    }
    res.redirect(`/show/${imageInfo.uuid}`);
});

app.get('/randomUUID', async (req, res) => {
    res.redirect(`/randomUUID/false`);
});

/**
 * GET /available-folders
 * Gets a list of folders in the working directory
 */
app.get('/available-folders', (req, res) => {
    const folders = fs.readdirSync('./').filter(file => fs.lstatSync(path.join('./', file)).isDirectory());
    res.json(folders);
});

/**
 * GET /set-download-location/:location
 * Sets the download location for the download manager
 */
app.get('/set-download-location/:location', (req, res) => {
    const { location } = req.params;
    const success = downloadManager.setDownloadLocation(location);
    res.json(success);
});

/**
 * GET /set-time-to-download/:time
 * Sets the time to download for the download manager
 */
app.get('/set-time-to-download/:time', (req, res) => {
    const { time } = req.params;
    const success = downloadManager.setTimeToDownload(time);
    res.json(success);
});

/**
 * GET /set-run-enabled/:enabled
 * Sets whether or not the download manager should run
 */
app.get('/set-run-enabled/:enabled', (req, res) => {
    const { enabled } = req.params;
    if (enabled === "true") {
        downloadManager.runEnabled = true;
        databaseUpdateManager.runEnabled = true;
        upscalerManager.runEnabled = true;
    }
    else {
        downloadManager.runEnabled = false;
        databaseUpdateManager.runEnabled = false;
        upscalerManager.runEnabled = false;
    }
    res.json(downloadManager.runEnabled);
});

/**
 * GET /loggerGet/:entries/:remove
 * Gets the most recent entries from the logger
 * @param {number} entries - the number of entries to get
 * @param {boolean} remove - whether or not to remove the entries from the logger
 * @returns {json} - the entries from the logger
 */
app.get('/loggerGet/:entries/:remove', (req, res) => {
    const { entries, remove } = req.params;
    if (remove === "true") console.log("removing entries from log");
    let log = systemLogger.getRecentEntries(entries, remove === "true");
    res.json(log);
});

/**
 * GET /loggerDelete/:id
 * Deletes an entry from the logger
 * @param {number} id - the id of the entry to delete
 */
app.get('/loggerDelete/:id', (req, res) => {
    const { id } = req.params;
    const success = systemLogger.deleteEntry(id);
    res.json(success);
});

/**
 * POST /logger
 * Endpoint for logging messages to the logger
 * @param {string} message - the message to log * 
 */
app.post('/logger', (req, res) => {
    const { message } = req.body;
    systemLogger.log(message);
    res.send('ok');
});

app.get('/image/recent/:limit/:offset', async (req, res) => {
    const { limit, offset } = req.params;
    const data = await imageDB.getEntriesOrderedByEnqueueTime(limit, offset);
    res.json(data);
});

app.get('/image/update/:id/:do_not_download', async (req, res) => {
    const { id, do_not_download } = req.params;
    let image = await imageDB.lookupByUUID(id);
    if (image === undefined) {
        res.status(404).send('Image not found');
        return;
    }
    const imageInfo = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height);
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
app.get('/image/:imageUuid', async (req, res) => {
    const { imageUuid } = req.params;
    const { width, height } = req.query;

    const imagePath = path.join(__dirname, 'output/all', imageUuid);

    // Ensure the file exists
    if (!fs.existsSync(imagePath)) {
        res.status(404).send('Image not found');
        return;
    }
    try {
        const image = sharp(imagePath);

        image.on('error', (error) => {
            console.error('Error processing image: ', { error });
            res.status(500).send('Server error');
        });

        // Resize the image if width or height are provided
        if (width || height) {
            const widthNum = width ? parseInt(width, 10) : null;
            const heightNum = height ? parseInt(height, 10) : null;
            image.resize(widthNum, heightNum, { fit: 'inside' });
        }

        // Output the image
        res.set('Content-Type', 'image/jpg');
        image.pipe(res);
    } catch (error) {
        console.error('Error processing image: ', { error });
        res.status(500).send('Server error');
    }
});

/**
 * GET /status
 * Endpoint for getting the status of the server
 * @returns {json} - the status of the server
 */
app.get('/status', async (req, res) => {
    res.json(await serverStatusMonitor.checkServerStatus());
});


app.get('/downloadRun', async (req, res) => {
    res.send("ok");
    await downloadManager.run();
});

app.get('/upscaleRun', async (req, res) => {
    res.send("ok");
    await upscalerManager.run();
});

////////////////////////////////////////////////////////////////////////////////////////
/////  Utilities
////////////////////////////////////////////////////////////////////////////////////////

function validatePNG(imagePath) {
    return new Promise((resolve) => {
        fs.createReadStream(imagePath)
            .pipe(new PNG())
            .on('parsed', function () {
                resolve(true);  // Valid PNG
            })
            .on('error', function (error) {
                // console.error('Invalid PNG:', error);
                resolve(false);  // Invalid PNG
            });
    });
}

function buildImageData(data) {
    let imageData = [];
    data.forEach((job) => {
        if (job.batch_size == 4) {
            for (let i = 0; i < 4; i++) {
                imageData.push(new ImageInfo(job.id, i, job.enqueue_time, job.full_command, job.width, job.height));
            }
        } else {
            imageData.push(new ImageInfo(job.parent_id, job.parent_grid, job.enqueue_time, job.full_command, job.width, job.height));
        }
    });
    return imageData;
}

function waitSeconds(seconds) {
    return new Promise((resolve, reject) => {
        setTimeout(() => { resolve(); }, seconds * 1000);
    });
}

function loadSettings() {
    if (fs.existsSync("settings.json")) {
        try {
            settings = JSON.parse(fs.readFileSync("settings.json"));
            return true;
        } catch (err) {
            return false;
        }
    } else {
        return false;
    }
}

function saveSettings() {
    fs.writeFileSync("settings.json", JSON.stringify(settings, null, 4));
    systemLogger?.log("Setting saved", new Date().toLocaleString());
}

systemLogger.log("Server started", new Date().toLocaleString());



process.on('exit', (code) => {
    saveSettings();
    console.log('exiting');
    imageDB.dbClient.end();
    systemLogger?.log("Server exited", new Date().toLocaleString());
});