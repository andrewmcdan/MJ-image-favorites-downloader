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

let settings: {
    downloadLocation: string,
    timeToDownload: number,
    runEnabled: boolean,
    updateDB: boolean    
} = { 
    downloadLocation: "output",
    timeToDownload: 0,
    runEnabled: false,
    updateDB: true
};


class DB_Error extends Error {
    static count = 0;
    constructor(message: string | undefined) {
        super(message);
        this.name = "DB_Error";
        Error.captureStackTrace?.(this, DB_Error);
        systemLogger?.log("DB_Error", message);
        DB_Error.count++;
    }
}

interface Entry{
    time: Date;
    message: any[];
    id: number;
}

class SystemLogger {
    logArr: Entry[];
    idIndex: number;
    constructor() {
        this.logArr = [];
        this.idIndex = 0;
    }

    log(...message: any[]) {
        let entry: Entry = { time: new Date(), message: message, id: this.idIndex++ };
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

    getMostRecentLog(remove = false):Entry | null {
        if (this.logArr.length === 0) return null;
        let logTemp = this.logArr[this.logArr.length - 1];
        if (remove) {
            this.logArr.pop();
        }
        return logTemp;
    }

    getRecentEntries(numberOfEntries: string | number, remove = false) {
        let entries: (Entry|null)[] = [];
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

    deleteEntry(id: string | number) {
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
    browser: any;
    page: any;
    loggedIntoMJ: boolean;
    loginInProgress: boolean;
    pageURL: string;
    mj_cookies: any;
    mj_localStorage: any;
    discordLoginComplete: boolean;
    discord_cookies: any;
    mj_sessionStorage: any;
    discord_localStorage: any;
    discord_sessionStorage: any;
    constructor() {
        this.browser = null;
        this.page = null;
        this.pageURL = "";
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
        return new Promise<void>(async (resolve, reject) => {
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
            // await waitSeconds(1);
            await this.page.setCookie(...this.mj_cookies);
            await discordPage.setCookie(...this.discord_cookies);
            // await waitSeconds(1);
            await discordPage?.close();

            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });
            // await waitSeconds(2);
            if (this.page.url().includes("imagine") || this.page.url().includes("explore")) {
                this.loggedIntoMJ = true;
                resolve();
            } else {
                this.loggedIntoMJ = false;
                reject("Session restore failed");
            }
        });
    }

    async loginToMJ(username: string, password: string, MFA_cb: () => Promise<string>) {
        return new Promise<void>(async (resolve, reject) => {
            if ((!this.loggedIntoMJ || this.browser == null) && !this.loginInProgress) {
                // attempt to restore session
                this.loadSession().then(() => { resolve(); }).catch(async () => {
                    this.loginInProgress = true;
                    if (this.browser !== null) await this.browser.close();
                    this.browser = await puppeteer.launch({ headless: 'new', defaultViewport: null, args: ['--start-maximized'] });
                    this.page = (await this.browser.pages())[0];

                    this.browser.on('targetcreated', async () => {
                        const pageList = await this.browser.pages();
                        let discordLoginPage = pageList[pageList.length - 1];
                        if (discordLoginPage.url().includes("discord.com/login")) {
                            await this.loginToDiscord(discordLoginPage, username, password, MFA_cb);
                        }
                    });

                    await this.page.goto('https://www.midjourney.com/home', { waitUntil: 'networkidle2', timeout: 60000 });
                    // await waitSeconds(5);

                    await this.page.click('button ::-p-text(Sign In)');
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

    async loginToDiscord(
        discordLoginPage: { 
            waitForSelector: (arg0: string, arg1: { timeout: number; } | undefined) => Promise<any>; type: (arg0: string, arg1: string) => any; keyboard: { press: (arg0: string) => any; }; click: (arg0: string) => any; }, username: string, password: string, MFA_cb: (() => string | PromiseLike<string>) | null) {
        await waitSeconds(1);
        await discordLoginPage.waitForSelector('input[name="email"]', { timeout: 60000 });
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
        return new Promise<object[]>(async (resolve, reject) => {
            if (!this.loggedIntoMJ) {
                await this.loginToMJ("","",()=>{
                    return new Promise((resolve, reject) => {
                        resolve("");
                    });
                }).catch((err) => {
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
            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });

            let data:object[] = await this.page.evaluate(async () => {
                const getUserUUID = async () => {
                    let homePage:Response = await fetch("https://www.midjourney.com/imagine");
                    let homePageText: string = await homePage.text();
                    let nextDataIndex:number = homePageText.indexOf("__NEXT_DATA__");
                    let nextData:string = homePageText.substring(nextDataIndex);
                    let startOfScript = nextData.indexOf("json\">");
                    let endOfScript = nextData.indexOf("</script>");
                    let script = nextData.substring(startOfScript + 6, endOfScript);
                    let json = script.substring(script.indexOf("{"), script.lastIndexOf("}") + 1);
                    let data = JSON.parse(json);
                    let userUUID:string = data.props.initialAuthUser.midjourney_id;
                    return userUUID;
                }
                let userUUID = await getUserUUID();
                let numberOfJobsReturned = 0;
                let cursor = "";
                let loopCount = 0;
                let returnedData:object[] = [];
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


                    let data:{data:object[], cursor:string} = await response.json();
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

    getSingleJobStatus(jobID: string) {
        return new Promise(async (resolve, reject) => {
            if (!this.loggedIntoMJ) reject("Not logged into MJ");
            if (this.loginInProgress) reject("Login in progress");
            await this.page.goto('https://www.midjourney.com/imagine', { waitUntil: 'networkidle2', timeout: 60000 });

            let data = await this.page.evaluate(async (jobID: string) => {
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
    systemLogger: SystemLogger;
    puppeteerClient: PuppeteerClient;
    downloadManager: DownloadManager;
    dbClient: Database;
    upscalerManager: UpscaleManager;
    databaseUpdateManager: DatabaseUpdateManager;
    serverStartTime: Date;
    constructor(SystemLogger: SystemLogger, PuppeteerClient: PuppeteerClient, DownloadManager: DownloadManager, DatabaseManager: Database, UpscaleManager: UpscaleManager, DatabaseUpdateManager: DatabaseUpdateManager) {
        this.systemLogger = SystemLogger;
        this.puppeteerClient = PuppeteerClient;
        this.downloadManager = DownloadManager;
        this.dbClient = DatabaseManager;
        this.upscalerManager = UpscaleManager;
        this.databaseUpdateManager = DatabaseUpdateManager;
        this.serverStartTime = new Date();
    }

    async checkServerStatus() {
        let status:{
            serverStartTime: Date,
            upTime: number,
            upTimeFormatted: string,
            numberOfLogEntries: number,
            database: {
                numberOfImages: number,
                errorCount: number
            },
            puppeteerClient: {
                loggedIntoMJ: boolean,
                loginInProgress: boolean
            },
            downloadManager: {
                downloadsInProgress: number,
                timeToDownload: number,
                runEnabled: boolean,
                downloadLocation: string
            },
            upscalerManager: {
                upscaleInProgress: boolean,
                runningUpscales: number,
                queuedUpscales: number
            },
            databaseUpdateManager: {
                updateInProgress: boolean,
                timeToUpdate: number,
                runEnabled: boolean
            }
        } = {
            serverStartTime: new Date(),
            upTime: 0,
            upTimeFormatted: "",
            numberOfLogEntries: 0,
            database: {
                numberOfImages: 0,
                errorCount: 0
            },
            puppeteerClient: {
                loggedIntoMJ: false,
                loginInProgress: false
            },
            downloadManager: {
                downloadsInProgress: 0,
                timeToDownload: 0,
                runEnabled: false,
                downloadLocation: ""
            },
            upscalerManager: {
                upscaleInProgress: false,
                runningUpscales: 0,
                queuedUpscales: 0
            },
            databaseUpdateManager: {
                updateInProgress: false,
                timeToUpdate: 0,
                runEnabled: false
            }
        };
        status.serverStartTime = this.serverStartTime;
        status.upTime = new Date().valueOf() - this.serverStartTime.valueOf();
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

        // status.database = {};
        status.database.numberOfImages = await this.dbClient.countImagesTotal();
        status.database.errorCount = DB_Error.count;

        // status.puppeteerClient = {};
        status.puppeteerClient.loggedIntoMJ = this.puppeteerClient.loggedIntoMJ;
        status.puppeteerClient.loginInProgress = this.puppeteerClient.loginInProgress;

        // status.downloadManager = {};
        status.downloadManager.downloadsInProgress = this.downloadManager.concurrentDownloads;
        status.downloadManager.timeToDownload = this.downloadManager.timeToDownload;
        status.downloadManager.runEnabled = this.downloadManager.runEnabled;
        status.downloadManager.downloadLocation = this.downloadManager.downloadLocation;

        // status.upscalerManager = {};
        status.upscalerManager.upscaleInProgress = this.upscalerManager.upscaleInProgress;
        status.upscalerManager.runningUpscales = this.upscalerManager.runningUpscales;
        status.upscalerManager.queuedUpscales = this.upscalerManager.queuedUpscales;

        // status.databaseUpdateManager = {};
        status.databaseUpdateManager.updateInProgress = this.databaseUpdateManager.updateInProgress;
        status.databaseUpdateManager.timeToUpdate = this.databaseUpdateManager.timeToUpdate;
        status.databaseUpdateManager.runEnabled = this.databaseUpdateManager.runEnabled;

        return status;
    }
};

class Database {
    dbClient: any;
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

    // TODO: need to implement auto DB update

    insertImage = async (image: ImageInfo, index: number) => {
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

    lookupByUUID = async (uuid: string) => {
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
        // if (downloadedOnly === "true") downloadedOnly = true;
        // if (downloadedOnly === "false") downloadedOnly = false;
        // if (typeof downloadedOnly !== "boolean") downloadedOnly = false;
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
    lookupImageByIndex = async (index:string, processedOnly = { processed: false, enabled: false }, downloadedOnly = { downloaded: false, enabled: false }, do_not_downloadOnly = { do_not_download: false, enabled: false }) => {
        // if (typeof index === 'number') index = index.toString();
        // if (typeof index === "string") {
        //     try {
        //         index = parseInt(index);
        //     } catch {
        //         return null;
        //     }
        //     index = index.toString();
        // } else {
        //     return null;
        // }
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
    updateImage = async (image: ImageInfo) => {
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
                downloaded = COALESCE($8, downloaded),
                do_not_download = COALESCE($9, do_not_download),
                processed = COALESCE($10, processed)
                WHERE uuid = $11`,
                [
                    image.parent_id,
                    image.grid_index,
                    image.enqueue_time,
                    image.fullCommand,
                    image.width,
                    image.height,
                    image.storageLocation,
                    image.downloaded !== null && image.downloaded !== undefined ? image.downloaded : null,
                    image.doNotDownload !== null && image.doNotDownload !== undefined ? image.doNotDownload : null,
                    image.processed !== null && image.processed !== undefined ? image.processed : null,
                    image.id
                ]
            );
            return res;
        } catch (err) {
            new DB_Error("Error updating image in database. Image ID: " + image.id);
            return null;
        }
    }
    deleteImage = async (uuid: string) => {
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
    setImageProcessed = async (uuid: string, valueBool = true) => {
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
    updateTimesSelectedPlusOne = async (uuid: string) => {
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
type boolTernary = true|false|null;
class ImageInfo {
    
    parent_id: string;
    grid_index: number;
    enqueue_time: Date;
    fullCommand: string;
    width: number;
    height: number;
    storageLocation: string;
    downloaded: boolTernary;
    doNotDownload: boolTernary;
    processed: boolTernary;
    constructor(parent_id: string, grid_index: number, enqueue_time: Date, fullCommand: string, width: number, height: number, storage_location = "") {
        this.parent_id = parent_id;
        this.grid_index = grid_index;
        this.enqueue_time = enqueue_time;
        this.fullCommand = fullCommand;
        // this.fullCommand = fullCommand.replace(/'/g, "\\'");
        this.width = width;
        this.height = height;
        this.storageLocation = storage_location;
        this.downloaded = null;
        this.doNotDownload = null;
        this.processed = null;
    }

    toJSON() {
        let t = { ...this };
        // t.urlFull = this.urlFull;
        // t.urlSmall = this.urlSmall;
        // t.urlMedium = this.urlMedium;
        // t.urlAlt = this.urlAlt;
        // t.urlParentGrid = this.urlParentGrid;
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
    dbClient: Database;
    puppeteerClient: PuppeteerClient;
    systemLogger: SystemLogger;
    updateInProgress: boolean;
    runTimeout: NodeJS.Timeout | undefined;
    timeToUpdate: number; // minutes after midnight
    runEnabled: boolean;
    constructor(DatabaseManager: Database, SystemLogger: SystemLogger, PuppeteerClient: PuppeteerClient) {
        this.dbClient = DatabaseManager;
        this.puppeteerClient = PuppeteerClient;
        this.systemLogger = SystemLogger;
        this.updateInProgress = false;
        this.runTimeout;
        this.timeToUpdate = 0; // minutes after midnight
        this.runEnabled = true;
        this.start();
    }

    start() {
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        let timeToUpdate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToUpdate / 60, this.timeToUpdate % 60, 0, 0);
        let timeUntilUpdate = timeToUpdate.valueOf() - now.valueOf();
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
        this.puppeteerClient.getUsersJobsData().then(async (dataTemp) => {
            let data:object[] = dataTemp;
            // console.log(typeof data);
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
    downloadLocation: string;
    timeToDownload: number; // minutes past midnight
    runEnabled: boolean;
    downloadInProgress: boolean;
    concurrentDownloads: number;
    runTimeout: NodeJS.Timeout | undefined;
    dbClient: Database;
    systemLogger: SystemLogger;
    verifyDownloadsInProgress: boolean;
    constructor(DatabaseManager: Database, SystemLogger: SystemLogger) {
        this.downloadLocation = "output";
        this.timeToDownload = 0; // minutes past midnight
        this.runEnabled = false;
        this.downloadInProgress = false;
        this.concurrentDownloads = 0;
        this.runTimeout;
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
        this.start();
        this.verifyDownloadsInProgress = false;
    }

    setDownloadLocation(location: string) {
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

    setTimeToDownload(time: string | number) {
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

    async downloadImage(url: string, image: ImageInfo):Promise<{success:boolean,error:string,image:ImageInfo, fileSize:number}> {
        let response;
        try {
            response = await fetch(url);
        } catch (err) {
            return ({ success: false, error: ""+err ,image:image, fileSize:0});
        }

        if (!response.ok) {
            return ({ success: false, error: "Bad response code: " + response.status, image:image, fileSize:0 });
        }
        if (response.headers.get('content-type') !== "image/png") {
            return ({ success: false, error: "Bad content type: " + response.headers.get('content-type') ,image:image, fileSize:0});
        }
        let contentLengthResult:string | null = response.headers.get('content-length');
        if(contentLengthResult == null) {
            contentLengthResult = "";
        }
        let contentLength = parseInt(contentLengthResult);
        if (contentLength < 1000) {
            return ({ success: false, error: "Bad content length: " + response.headers.get('content-length'),image:image, fileSize:0 });
        }
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
        fileSize = parseInt(file.size);
        if (fileSize != contentLength) {
            return ({ success: false, error: "File size mismatch: " + fileSize + " != " + contentLength , image:image, fileSize:0});
            // return; 
        }
        console.log("Downloaded image " + destFileName + " of size " + fileSize + " bytes");
        image.downloaded = true;
        image.storageLocation = path.join(destFolder, destFileName);
        image.processed = true;
        // image.fileSize = fileSize;
        // image.success = true;
        return {image:image, success:true, error:"", fileSize:fileSize};
    }

    start() {
        if (this.runTimeout !== null) clearTimeout(this.runTimeout);
        let now = new Date();
        let timeToDownload = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.timeToDownload / 60, this.timeToDownload % 60, 0, 0);
        let timeUntilDownload = timeToDownload.valueOf() - now.valueOf();
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
        }
        if (this.downloadInProgress === true) return;
        this.downloadInProgress = true;
        await this.verifyDownloads();
        this.concurrentDownloads = 0;
        let imageCount = await this.dbClient.countImagesTotal();
        console.log("Image count: " + imageCount);
        let success = true;
        for (let i = 0; i < imageCount; i++) {
            if (!(await this.lookupAndDownloadImageByIndex(i.toString()))) success = false;
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

    async lookupAndDownloadImageByIndex(index: string) {
        if (!this.runEnabled) return true;
        let image = await this.dbClient.lookupImageByIndex(index, { processed: true, enabled: true }, { downloaded: false, enabled: true }, { do_not_download: false, enabled: true });
        if (image === undefined) return true;
        if (image === null) return true;
        image = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height);

        this.concurrentDownloads++;
        let imageResult: {success:boolean,error:string,image:ImageInfo, fileSize:number};
        try {
            imageResult = await this.downloadImage(image.urlAlt, image);
        } catch (err) {
            this.systemLogger.log("Error downloading image", err, image);
            return false;
        }
        this.concurrentDownloads--;

        if (imageResult.success === true) {
            await this.dbClient.updateImage(imageResult.image);
        } else {
            this.systemLogger?.log("Error downloading image", imageResult.error, image);
            let url = image.urlFull;
            if (imageResult.error.includes("File size mismatch")) {
                url = image.urlAlt;
            }
            this.concurrentDownloads++;
            let altImageResult;
            try {
                altImageResult = await this.downloadImage(url, image);
            } catch (err) {
                this.systemLogger.log("Error downloading image", err, image);
                return false;
            }
            this.concurrentDownloads--;
            if (altImageResult.success === true) {
                await this.dbClient.updateImage(altImageResult.image);
            } else {
                this.systemLogger.log("Error downloading image", altImageResult.error, image);
                return false;
            }
        }
        return true;
    }

    checkFileExistsPath(path: string) {
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
            let image = await this.dbClient.lookupImageByIndex(i.toString(), { processed: true, enabled: true }, { downloaded: true, enabled: false }, { do_not_download: false, enabled: true });
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
    dbClient: Database;
    systemLogger: SystemLogger;
    upscaler: typeof Upscaler;
    upscaleInProgress: boolean;
    runningUpscales: number;
    queuedUpscales: number;

    constructor(DatabaseManager: Database, SystemLogger: SystemLogger) {
        this.dbClient = DatabaseManager;
        this.systemLogger = SystemLogger;
        this.upscaleInProgress = false;
        this.runningUpscales = 0;
        this.queuedUpscales = 0;
        this.upscaler = new Upscaler({
            defaultScale: 4, // can be 2, 3, or 4
            defaultFormat: "jpg", // or "png"
            downloadProgressCallback: () => { }, // Callback that gets called twice per second while a download is in progress
            defaultModel: "ultrasharp-2.0.1", // Default model name 
            maxJobs: 2 // Max # of concurrent jobs
        });
    }
};

const puppeteerClient = new PuppeteerClient();
const systemLogger = new SystemLogger();
const imageDB = new Database();
const downloadManager = new DownloadManager(imageDB, systemLogger);

(async () => {
    console.log("Verifying downloads");
    await downloadManager.verifyDownloads();
    console.log("Done verifying downloads");
})()

const upscalerManager = new UpscaleManager(imageDB, systemLogger);
const databaseUpdateManager = new DatabaseUpdateManager(imageDB, systemLogger, puppeteerClient);

const serverStatusMonitor = new ServerStatusMonitor(systemLogger, puppeteerClient, downloadManager, imageDB, upscalerManager, databaseUpdateManager);


if (!loadSettings()) {
    systemLogger?.log("Settings file not found. Using default settings", new Date().toLocaleString());
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
    let ipAddresses:any[] = [];
    Object.keys(ifaces).forEach(function (ifname) {
        let alias = 0;
        ifaces[ifname].forEach(function (iface:any) {
            if ('IPv4' !== iface.family || iface.internal !== false) return;
            ipAddresses.push(iface.address);
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
app.get('/', (req: any, res: { render: (arg0: string) => void; }) => {
    res.render('index');
});

/**
 * GET /images
 * Images page for viewing images and selecting them for download
 */
app.get('/images', (req: any, res: { render: (arg0: string) => void; }) => {
    res.render('images');
});

app.get('/tools', (req: any, res: { render: (arg0: string) => void; }) => {
    res.render('tools');
});

/**
 * GET /login/:username/:password
 * Login endpoint for logging into Midjourney
 * @param {string} username - username for Midjourney
 * @param {string} password - password for Midjourney
 * @returns {string} - "ok" once credentials have been entered
 */
app.get('/login/:username/:password', async (req: any, res: { send: (arg0: string) => void; }) => {
    const { username, password } = req.params;
    puppeteerClient.loginToMJ(username, password, async () => {
        let retData = "";
        /**
         * GET /mfa/:data
         * Endpoint for getting the MFA code from the user
         * @param {string} data - the MFA code
         * @returns {string} - the MFA code
         */
        app.get('/mfa/:data', (req: any, res: { send: (arg0: any) => void; }) => {
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
 * @returns {string} - "ok" once the update has been triggered
 */
app.get('/updateDB', async (req: any, res: { send: (arg0: any) => void; }) => {
    databaseUpdateManager.run();
    res.send("ok");
});

/**
 * GET /show
 * Shows a slideshow of images from the database
 */
app.get('/show', (req: any, res: { render: (arg0: string) => void; }) => {
    res.render('show');
});

/**
 * GET /show/:uuid
 * Shows a single image from the database
 * @param {string} uuid - the uuid of the image to show
 * @returns {string} - html that shows the image and is a link to another random image. JSON is also embedded in the html.
 */
app.get('/show/:uuid', async (req: any, res: { render: (arg0: string) => void; send: (arg0: string) => void; }) => {
    const { uuid } = req.params;
    if (uuid === "" || uuid === undefined) res.render('show');
    else {
        console.log("looking up uuid: ", uuid);
        const image = await imageDB.lookupByUUID(uuid);
        const imageInfo = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height, image.storage_location);
        imageDB.updateTimesSelectedPlusOne(uuid);
        res.send(`<a href="/randomUUID"><img src="${imageInfo.urlFull}" /></a><script type="application/json">${JSON.stringify(imageInfo)}</script>`);
    }
});

/**
 * GET /randomUUID
 * Redirects to a random image
 */
app.get('/randomUUID/:dlOnly', async (req: any, res: { redirect: (arg0: string) => void; }) => {
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

app.get('/randomUUID', async (req: any, res: { redirect: (arg0: string) => void; }) => {
    res.redirect(`/randomUUID/false`);
});

/**
 * GET /available-folders
 * Gets a list of folders in the working directory
 */
app.get('/available-folders', (req: any, res: { json: (arg0: any) => void; }) => {
    const folders = fs.readdirSync('./').filter((file: any) => fs.lstatSync(path.join('./', file)).isDirectory());
    res.json(folders);
});

/**
 * GET /set-download-location/:location
 * Sets the download location for the download manager
 */
app.get('/set-download-location/:location', (req: any, res: { json: (arg0: boolean) => void; }) => {
    const { location } = req.params;
    const success = downloadManager.setDownloadLocation(location);
    res.json(success);
});

/**
 * GET /set-time-to-download/:time
 * Sets the time to download for the download manager
 */
app.get('/set-time-to-download/:time', (req: any, res: { json: (arg0: boolean) => void; }) => {
    const { time } = req.params;
    const success = downloadManager.setTimeToDownload(time);
    res.json(success);
});

/**
 * GET /set-run-enabled/:enabled
 * Sets whether or not the download manager should run
 */
app.get('/set-run-enabled/:enabled', (req: any, res: { json: (arg0: boolean) => void; }) => {
    const { enabled } = req.params;
    if (enabled === "true") {
        downloadManager.runEnabled = true;
        databaseUpdateManager.runEnabled = true;
    }
    else {
        downloadManager.runEnabled = false;
        databaseUpdateManager.runEnabled = false;
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
app.get('/loggerGet/:entries/:remove', (req: any, res: { json: (arg0: (Entry | null)[]) => void; }) => {
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
app.get('/loggerDelete/:id', (req: any, res: { json: (arg0: boolean) => void; }) => {
    const { id } = req.params;
    const success = systemLogger.deleteEntry(id);
    res.json(success);
});

/**
 * POST /logger
 * Endpoint for logging messages to the logger
 * @param {string} message - the message to log * 
 */
app.post('/logger', (req: any, res: { send: (arg0: string) => void; }) => {
    const { message } = req.body;
    systemLogger.log(message);
    res.send('ok');
});

app.get('/image/recent/:limit/:offset', async (req: any, res: { json: (arg0: any) => void; }) => {
    const { limit, offset } = req.params;
    const data = await imageDB.getEntriesOrderedByEnqueueTime(limit, offset);
    res.json(data);
});

app.get('/image/update/:id/:do_not_download', async (req: any, res: { status: (arg0: number) => { (): any; new(): any; send: { (arg0: string): void; new(): any; }; }; json: (arg0: ImageInfo) => void; }) => {
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
app.get('/image/:imageUuid', async (req: any, res: { status: (arg0: number) => { (): any; new(): any; send: { (arg0: string): void; new(): any; }; }; set: (arg0: string, arg1: string) => void; }) => {
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

        image.on('error', (error: any) => {
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
app.get('/status', async (req: any, res: { json: (arg0: { serverStartTime: Date; upTime: number; upTimeFormatted: string; numberOfLogEntries: number; database: { numberOfImages: number; errorCount: number; }; puppeteerClient: { loggedIntoMJ: boolean; loginInProgress: boolean; }; downloadManager: { downloadsInProgress: number; timeToDownload: number; runEnabled: boolean; downloadLocation: string; }; upscalerManager: { upscaleInProgress: boolean; runningUpscales: number; queuedUpscales: number; }; databaseUpdateManager: { updateInProgress: boolean; timeToUpdate: number; runEnabled: boolean; }; }) => void; }) => {
    res.json(await serverStatusMonitor.checkServerStatus());
});


app.get('/downloadRun', async (req: any, res: { send: (arg0: string) => void; }) => {
    res.send("ok");
    await downloadManager.run();
});

////////////////////////////////////////////////////////////////////////////////////////
/////  Utilities
////////////////////////////////////////////////////////////////////////////////////////

function validatePNG(imagePath: any) {
    return new Promise((resolve) => {
        fs.createReadStream(imagePath)
            .pipe(new PNG())
            .on('parsed', function () {
                resolve(true);  // Valid PNG
            })
            .on('error', function () {
                // console.error('Invalid PNG:', error);
                resolve(false);  // Invalid PNG
            });
    });
}

function buildImageData(data: any[]) {
    let imageData:ImageInfo[] = [];
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

function waitSeconds(seconds: number) {
    return new Promise<void>((resolve, reject) => {
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