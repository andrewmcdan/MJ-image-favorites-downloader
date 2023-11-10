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
 * 2. make it so that the server runs puppeteer instead of usaing the browser extension
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
const axios = require('axios');
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
const { setTimeout } = require('timers/promises');
puppeteer.use(StealthPlugin());

let updateDB = true;

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
                this.browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
                this.page = (await this.browser.pages())[0];
            }

            await this.page.goto('https://www.midjourney.com/home', { waitUntil: 'networkidle2', timeout: 60000 });
            let discordPage = await this.browser.newPage();
            await discordPage.goto('https://discord.com/');
            await waitSeconds(1);
            await this.page.setCookie(...this.mj_cookies);
            await discordPage.setCookie(...this.discord_cookies);
            await waitSeconds(1);

            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });
            await waitSeconds(2);
            this.pageURL = this.page.url();
            if (this.pageURL.includes("imagine") || this.pageURL.includes("explore")) {
                this.loggedIntoMJ = true;
                await discordPage?.close();
                resolve();
            } else {
                this.loggedIntoMJ = false;
                reject("Session restore failed");
            }
        });
    }

    async loginToMJ(username, password, MFA_cb = null) {
        return new Promise(async (resolve, reject) => {
            if ((!this.loggedIntoMJ || this.browser == null) && !this.loginInProgress) {
                // attempt to restore session
                try {
                    await this.loadSession();
                    resolve();
                    return;
                } catch (err) {
                    console.log(err);
                }

                this.loginInProgress = true;
                this.browser = await puppeteer.launch({ headless: 'new', defaultViewport: null, args: ['--start-maximized'] });
                this.page = (await this.browser.pages())[0];

                this.browser.on('targetcreated', async (target) => {
                    const pageList = await this.browser.pages();
                    let discordLoginPage = pageList[pageList.length - 1];
                    if (discordLoginPage.url().includes("discord.com/login")) {
                        await this.loginToDiscord(discordLoginPage, username, password, MFA_cb);
                    }
                });

                await this.page.goto('https://www.midjourney.com/home', { waitUntil: 'networkidle2', timeout: 60000 });
                await waitSeconds(5);

                await this.page.click('button ::-p-text(Sign In)');
                await waitSeconds(1);
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
            }
            if (this.loggedIntoMJ) {
                await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });
                resolve();
            }
        });
    }

    async loginToDiscord(discordLoginPage, username, password, MFA_cb) {
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
            if (!this.loggedIntoMJ) reject("Not logged into MJ");
            if (this.loginInProgress) reject("Login in progress");
            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });

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
    constructor(SystemLogger, PuppeteerClient, DownloadManager) {
        this.systemLogger = SystemLogger;
        this.puppeteerClient = PuppeteerClient;
        this.downloadManager = DownloadManager;
        this.serverStartTime = new Date();
    }

    checkServerStatus() {
        let status = {};
        status.serverStartTime = this.serverStartTime;
        status.upTime = new Date() - this.serverStartTime;
        status.upTimeFormatted = new Date(status.upTime).toISOString().substring(11, 8);
        status.numberOfLogEntries = this.systemLogger.getNumberOfEntries();

        status.database = {};
        status.database.numberOfImages = countImages_DB();
        status.database.errorCount = DB_Error.count;

        status.puppeteerClient = {};
        status.puppeteerClient.loggedIntoMJ = this.puppeteerClient.loggedIntoMJ;
        status.puppeteerClient.loginInProgress = this.puppeteerClient.loginInProgress;

        status.downloadManager = {};
        status.downloadManager.downloadInProgress = this.downloadManager.downloadInProgress;
        status.downloadManager.timeToDownload = this.downloadManager.timeToDownload;
        status.downloadManager.runEnabled = this.downloadManager.runEnabled;
        status.downloadManager.downloadLocation = this.downloadManager.downloadLocation;
        status.downloadManager.downloadInProgress = this.downloadManager.downloadInProgress;

        return status;
    }
};

class DatabaseManager {
    constructor() {
        this.dbClient = new pgClient.Client({
            user: 'mjuser',
            host: 'postgresql.lan',
            database: 'mjimages',
            password: 'mjImagesPassword',
            port: 5432,
        });
        this.dbClient.connect();
    }

    insertImage = async (image, index) => {
        // find if image exists in database
        // if it does, update it
        if (await lookupImageUUID_DB(image.id) !== undefined) {
            await updateImage_DB(image);
            return;
        }
        // if it doesn't, insert it
        let res;
        try {
            res = await this.dbClient.query(
                `INSERT INTO images (uuid, parent_uuid, grid_index, enqueue_time, full_command, width, height, storage_location, downloaded, do_not_download, processed, index) 
             VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    image.id,
                    image.parent_id,
                    image.grid_index,
                    image.enqueue_time,
                    image.fullCommand,
                    image.width,
                    image.height,
                    image.storageLocation,
                    image.downloaded,
                    image.doNotDownload,
                    image.processed,
                    index
                ]
            );
        } catch (err) {
            new DB_Error("Error inserting image into database. Image ID: " + image.id);
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
        try {
            let res;
            if (downloadedOnly) {
                res = await this.dbClient.query(
                    `SELECT * FROM images WHERE downloaded = true ORDER BY RANDOM() / (times_selected+1) DESC LIMIT 1`
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
    lookupImageByIndex = async (index, processedOnly =  {processed: false, enabled: false}, downloadedOnly = {downloaded:false,enabled: false}, do_not_downloadOnly = {do_not_download: false, enabled: false}) => {
        if(typeof index === 'number') index = index.toString();
        if(typeof index === "string") {
            try{
                index = parseInt(index);
            }catch{
                return null;
            }
            index = index.toString();
        }else{
            return null;
        }
        // at this point index should be a string that is a number. Anything else would have returned null
        try {
            let queryParts = ['SELECT * FROM images WHERE id = $1'];
            let queryParams = [index];

            if (processedOnly.enabled===true) {
                queryParts.push("AND processed = " + (processedOnly.processed===true ? "true" : "false"));
            }
            if (downloadedOnly.enabled===true) {
                queryParts.push("AND downloaded = " + (downloadedOnly.downloaded===true ? "true" : "false"));
            }
            if (do_not_downloadOnly.enabled===true) {
                queryParts.push("AND do_not_download = " + (do_not_downloadOnly.do_not_download===true ? "true" : "false"));
            }

            queryParts.push("LIMIT 1");

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
                parent_uuid = $1,
                grid_index = $2,
                enqueue_time = $3,
                full_command = $4,
                width = $5,
                height = $6,
                storage_location = $7,
                downloaded = $8,
                do_not_download = $9,
                processed = $10
             WHERE uuid = $11`,
                [
                    image.parent_id,
                    image.grid_index,
                    image.enqueue_time,
                    image.fullCommand,
                    image.width,
                    image.height,
                    image.storageLocation,
                    image.downloaded,
                    image.doNotDownload,
                    image.processed,
                    image.id
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
};

class ImageInfo {
    constructor(parent_id, grid_index, enqueue_time, fullCommand, width, height) {
        this.parent_id = parent_id;
        this.grid_index = grid_index;
        this.enqueue_time = enqueue_time;
        this.fullCommand = fullCommand;
        // this.fullCommand = fullCommand.replace(/'/g, "\\'");
        this.width = width;
        this.height = height;
        this.storageLocation = "";
        this.downloaded = false;
        this.doNotDownload = false;
        this.processed = false;
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

class DownloadManager {
    constructor(DatabaseManager = null, SystemLogger = null) {
        this.downloadLocation = "output";
        this.timeToDownload = 0; // minutes past midnight
        this.runEnabled = false;
        this.downloadInProgress = false;
        this.runTimeout = null;
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
    }

    downloadImage(url) {
        return new Promise(async (resolve, reject) => {
            const response = await axios.get(url, { responseType: 'stream' });
            if (response.status !== 200) { reject("Bad response code: " + response.status); return; }
            if (response.headers['content-type'] !== "image/png") { reject("Bad content type: " + response.headers['content-type']); return; }
            if (response.headers['content-length'] < 1000) { reject("Bad content length: " + response.headers['content-length']); return; }
            let contentLength = response.headers['content-length'];
            if (!fs.existsSync(this.downloadLocation)) fs.mkdirSync(this.downloadLocation, { recursive: true });
            // https://storage.googleapis.com/dream-machines-output/53ae5df3-edef-4adb-a4c2-586de79edfe9/0_0.png
            let splitImage = url.split('/');
            splitImage = splitImage[splitImage.length - 2] + splitImage[splitImage.length - 1];
            response.data.pipe(fs.createWriteStream(path.join(this.downloadLocation, splitImage)));
            let fileSize = 0;
            let file = fs.readFileSync(path.join(this.downloadLocation, splitImage));
            fileSize = file.length;
            if (fileSize !== contentLength) { reject("File size mismatch: " + fileSize + " != " + contentLength); return; }
            resolve({ fileSize: fileSize, storageLocation: path.join(this.downloadLocation, splitImage) });
        });
    }

    start() {
        let now = new Date();
        let timeToDownload = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToDownload / 60, this.timeToDownload % 60, 0, 0);
        let timeUntilDownload = timeToDownload - now;
        if (timeUntilDownload < 0) timeUntilDownload += 1000 * 60 * 60 * 24;
        this.runTimeout = setTimeout(this.run, timeUntilDownload);
    }

    async run() {
        let imageCount = await dbClient.countImagesTotal();
        for (let i = 0; i < imageCount; i++) {
            let image = await dbClient.lookupImageByIndex(i, {processed: true, enabled: true}, {downloaded: false, enabled: true}, {do_not_download: false, enabled: true});
            if (image === undefined) continue;
            if (image === null) continue;

            console.log(image); // TODO: remove this
            if (i > 10) break;/////      and this

            this.downloadInProgress = true;
            this.downloadImage(image.urlFull).then(async (obj) => {
                image.downloaded = true;
                image.storageLocation = obj.storageLocation;
                await dbClient.updateImage(image);
                this.downloadInProgress = false;
            }).catch((err) => {
                console.log(err); // TODO: remove this
                this.downloadImage(image.urlAlt).then(async (obj) => {
                    image.downloaded = true;
                    image.storageLocation = obj.storageLocation;
                    await dbClient.updateImage(image);
                }).catch((err) => {
                    console.log(err);
                    this.systemLogger.log("Error downloading image", err, image);
                }).finally(() => {
                    this.downloadInProgress = false;
                });
            });
            while (this.downloadInProgress) {
                await waitSeconds(0.1);
            }
        }
        this.start();
    }

    checkFileExistsPath(path) {
        fs.access(path, fs.F_OK, (err) => {
            if (err) return false;
            else return true;
        });
    }
};

const puppeteerClient = new PuppeteerClient();
const systemLogger = new SystemLogger();
const imageDB = new DatabaseManager();
const downloadManager = new DownloadManager(imageDB, systemLogger);
const serverStatusMonitor = new ServerStatusMonitor(systemLogger, puppeteerClient, downloadManager);

/*const dbClient = new pgClient.Client({
    user: 'mjuser',
    host: 'postgresql.lan',
    database: 'mjimages',
    password: 'mjImagesPassword',
    port: 5432,
});
dbClient.connect();*/

/*
const insertImage_DB = async (image, index) => {
    // find if image exists in database
    // if it does, update it
    if (await lookupImageUUID_DB(image.id) !== undefined) {
        await updateImage_DB(image);
        return;
    }
    // if it doesn't, insert it
    let res;
    try {
        res = await dbClient.query(
            `INSERT INTO images (uuid, parent_uuid, grid_index, enqueue_time, full_command, width, height, storage_location, downloaded, do_not_download, processed, index) 
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                image.id,
                image.parent_id,
                image.grid_index,
                image.enqueue_time,
                image.fullCommand,
                image.width,
                image.height,
                image.storageLocation,
                image.downloaded,
                image.doNotDownload,
                image.processed,
                index
            ]
        );
    } catch (err) {
        console.log({ err });
        // console.log(JSON.stringify(image, null, 4));
        // process.exit();
        systemLogger.log("Error inserting image into database", err, image);
    }
    return res;
}*/

/*
const lookupImageUUID_DB = async (uuid) => {
    try {
        const res = await dbClient.query(
            `SELECT * FROM images WHERE uuid = $1`,
            [uuid]
        );

        if (res.rows.length > 0) {
            return res.rows[0];
        }
        return undefined;
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error looking up image in database", err, uuid);
        return null;
    }
}*/

/*
const getRandomImage_DB = async (downloadedOnly = false) => {
    try {
        let res;
        if(downloadedOnly) {
            res = await dbClient.query(
                `SELECT * FROM images WHERE downloaded = true ORDER BY RANDOM() / (times_selected+1) DESC LIMIT 1`
            );
        }else{
            res = await dbClient.query(
                `SELECT * FROM images ORDER BY RANDOM() / (times_selected+1) DESC LIMIT 1`
            );
        }
        if (res.rows.length > 0) {
            return res.rows[0];
        }
        return undefined;
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error looking up random image in database", err);
        return null;
    }
}*/

/*
const lookupImagesIndex_DB = async (index) => {
    try {
        const res = await dbClient.query(
            `SELECT * FROM images WHERE id = $1`,
            [index]
        );
        if (res.rows.length > 0) {
            return res.rows[0];
        }
        return undefined;
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error looking up image in database", err, index);
        return null;
    }
}*/

/*
const updateImage_DB = async (image) => {
    try {
        const res = await dbClient.query(
            `UPDATE images SET 
            parent_uuid = $1,
            grid_index = $2,
            enqueue_time = $3,
            full_command = $4,
            width = $5,
            height = $6,
            storage_location = $7,
            downloaded = $8,
            do_not_download = $9,
            processed = $10
         WHERE uuid = $11`,
            [
                image.parent_id,
                image.grid_index,
                image.enqueue_time,
                image.fullCommand,
                image.width,
                image.height,
                image.storageLocation,
                image.downloaded,
                image.doNotDownload,
                image.processed,
                image.id
            ]
        );
        return res;
    } catch (err) {
        console.log({ err });
        // console.log(JSON.stringify(image, null, 4));
        systemLogger.log("Error updating image in database", err, image);
        return null;
    }
}*/

/*
const deleteImage_DB = async (uuid) => {
    try {
        const res = await dbClient.query(
            `DELETE FROM images WHERE uuid = $1`,
            [uuid]
        );
        return res;
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error deleting image from database", err, uuid);
        return null;
    }
}*/

/*
const countImages_DB = async () => {
    try {
        const res = await dbClient.query(
            `SELECT COUNT(*) FROM images`
        );
        return res.rows[0].count;
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error counting images in database", err);
        return null;
    }
}*/

/*
const setImageProcessed_DB = async (uuid, valueBool = true) => {
    if(typeof valueBool === "string") valueBool = (valueBool === "true");
    if(typeof valueBool !== "boolean") throw new Error("valueBool must be a boolean");
    try {
        const res = await dbClient.query(
            `UPDATE images SET processed = $1 WHERE uuid = $2`,
            [valueBool, uuid]
        );
        return res;
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error setting image processed in database", err, uuid);
        return null;
    }
}*/

/*
const updateTimesSelectedPlusOne_DB = async (uuid) => {
    try {
        // get times_selected for uuid
        let res = await dbClient.query(
            `SELECT times_selected FROM images WHERE uuid = $1`,
            [uuid]
        );
        let timesSelected = res.rows[0].times_selected;
        // add 1 to it
        timesSelected++;
        // update times_selected for uuid
        res = await dbClient.query(
            `UPDATE images SET times_selected = $1 WHERE uuid = $2`,
            [timesSelected, uuid]
        );
    } catch (err) {
        console.log({ err });
        systemLogger.log("Error updating times_selected in database", err, uuid);
        return null;
    }
}*/

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the "public" directory
app.use(express.static('public'));
// app.use(express.static('output'));



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
 * GET /login/:username/:password
 * Login endpoint for logging into Midjourney
 * @param {string} username - username for Midjourney
 * @param {string} password - password for Midjourney
 * @returns {string} - "ok" once credentials have been entered
 */
app.get('/login/:username/:password', async (req, res) => {
    const { username, password } = req.params;
    puppeteerClient.loginToMJ(username, password, async () => {
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
    }).catch((err) => {
        console.log(err);
    });
    res.send("ok");
});

/**
 * GET /updateDB
 * Endpoint for triggering an update of the database with the latest jobs from Midjourney
 * @returns {string} - "ok" if PuppeteerClient is logged into Midjourney, "not ok" if not
 */
app.get('/updateDB', async (req, res) => {
    let data;
    puppeteerClient.getUsersJobsData().then(async (dataTemp) => {
        data = dataTemp;
        console.log(typeof data);
        console.log("Size of data: ", data.length, "\nCalling buildImageData()");
        let imageData = buildImageData(data);
        console.log("Size of data: ", imageData.length, "\nDone building imageData\nUpdating database");
        for (let i = 0; i < imageData.length; i++) {
            // await insertUUID(imageData[i].id, i);
            if (updateDB) await imageDB.insertImage(imageData[i], i);
        }
        console.log("Done updating database");
    }).catch((err) => {
        console.log(err);
    });

    if (puppeteerClient.loggedIntoMJ) {
        res.send("ok");
    } else {
        res.send("not ok");
    }
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
        const imageInfo = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height);
        imageDB.updateTimesSelectedPlusOne(uuid);
        res.send(`<a href="/randomUUID"><img src="${imageInfo.urlFull}" /></a><script type="application/json">${JSON.stringify(imageInfo)}</script>`);
    }
});

/**
 * GET /randomUUID
 * Redirects to a random image
 */
app.get('/randomUUID', async (req, res) => {
    const imageInfo = await imageDB.getRandomImage();
    res.redirect(`/show/${imageInfo.uuid}`);
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
app.get('/status', (req, res) => {
    res.json(serverStatusMonitor.checkServerStatus());
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
                console.error('Invalid PNG:', error);
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

const waitSeconds = (seconds) => {
    return new Promise((resolve, reject) => {
        setTimeout(() => { resolve(); }, seconds * 1000);
    });
};

systemLogger.log("Server started");
systemLogger.log("a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. a really long log entry. ");
systemLogger.log("an entry with objects", { a: 1, b: 2, c: 3 }, { d: 4, e: 5, f: 6 });
systemLogger.log("an entry with arrays", [1, 2, 3], [4, 5, 6]);
systemLogger.log("an entry with strings", "string1", "string2");
systemLogger.log("an entry with numbers", 1, 2, 3, 4, 5, 6);
systemLogger.log("an entry with booleans", true, false, true, false);
systemLogger.log("an entry with undefined", undefined);
systemLogger.log("an entry with null", null);
systemLogger.log("an entry with a function", function () { console.log("hello"); });
systemLogger.log("an entry with a class", new ImageInfo("parent_id", 0, 0, "fullCommand", 0, 0));
systemLogger.log("an entry with a class", new DB_Error("this is an error"));

process.stdin.on('data', function (data) {
    console.log(data.toString());
    if (data.toString().trim() === 'exit') {
        process.exit();
    }
    if (data.toString().trim() === 'ls') {
        console.log(JSON.stringify(checkArray, null, 2));
    }
});

process.on('exit', (code) => {
    console.log('exiting');
    dbClient.end();
});