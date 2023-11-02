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
const AdmZip = require('adm-zip');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const PNG = require('pngjs').PNG;
const app = express();
const port = 3000;
app.use(bodyParser.json({ limit: '100mb' }));
const pgClient = require('pg');

let updateDB = false;

class DB_Error extends Error {
    constructor(message) {
        super(message);
        this.name = "DB_Error";
        Error.captureStackTrace && Error.captureStackTrace(this, DB_Error);
        if(systemLogger) systemLogger.log("DB_Error", message);
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
        if (this.logArr.length > 0) {
            let logTemp = this.logArr[this.logArr.length - 1];
            if (remove) {
                this.logArr.pop();
            }
            return logTemp;
        } else {
            return null;
        }
    }

    getRecentEntries(numberOfEntries, remove = false) {
        let entries = [];
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
        if(typeof id === "string") id = parseInt(id);
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

const systemLogger = new SystemLogger();

const dbClient = new pgClient.Client({
    user: 'mjuser',
    host: 'postgresql.lan',
    database: 'mjimages',
    password: 'mjImagesPassword',
    port: 5432,
});
dbClient.connect();

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
}

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
}

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
}

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
}

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
}

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
}

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
}

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
}

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
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the "public" directory
app.use(express.static('public'));
app.use(express.static('output'));

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
}


let imageData = [];


async function downloadImages(images, location) {
    for (let image of images) {
        const response = await axios.get(image, { responseType: 'stream' });
        // https://storage.googleapis.com/dream-machines-output/53ae5df3-edef-4adb-a4c2-586de79edfe9/0_0.png
        let splitImage = image.split('/');
        splitImage = splitImage[splitImage.length - 2] + splitImage[splitImage.length - 1];
        response.data.pipe(fs.createWriteStream(path.join(location, splitImage)));
    }
}


/***********************************
 * 
 * Server endpoints
 * 
 * 
 * 
 * 
 * 
 */

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

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.set('view engine', 'ejs');

app.get('/images', (req, res) => {
    res.render('images', { imageData });
});

app.get('/tools', (req, res) => {
    res.render('tools');
});

// starts a show of random images from the database that changes every so often
app.get('/show', (req, res) => {
    res.render('show');
});

// shows a specific image from the database
app.get('/show/:uuid', async (req, res) => {
    const { uuid } = req.params;
    if (uuid === "" || uuid === undefined) res.render('show');
    else {
        // const index = imageDataMap.get(uuid);
        console.log("looking up uuid: ", uuid);
        const image = await lookupImageUUID_DB(uuid);
        // console.log("index: ", image);
        const imageInfo = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height);
        updateTimesSelectedPlusOne_DB(uuid);
        res.send(`<a href="/randomUUID"><img src="${imageInfo.urlFull}" /></a><script type="application/json">${JSON.stringify(imageInfo)}</script>`);
    }
});

// selects a random image from the database and redirects to the show page for that image
app.get('/randomUUID', async (req, res) => {
    // let max = await countImages_DB();
    // const imageInfo = await lookupImagesIndex_DB((Math.floor(Math.random() * max) + 1));
    const imageInfo = await getRandomImage_DB();
    // console.log(imageInfo);
    // const imageInfo = imageData[Math.floor(Math.random() * imageData.length)];
    res.redirect(`/show/${imageInfo.uuid}`);
});

// get a list of folders in the current directory
app.get('/available-folders', (req, res) => {
    const folders = fs.readdirSync('./').filter(file => fs.lstatSync(path.join('./', file)).isDirectory());
    res.json(folders);
});

// get some entries from the logger
app.get('/loggerGet/:entries/:remove', (req, res) => {
    const { entries, remove } = req.params;
    if(remove === "true") console.log("removing entries from log");
    let log = systemLogger.getRecentEntries(entries,remove === "true");
    res.json(log);
});

// delete an entry in the logger
app.get('/loggerDelete/:id', (req, res) => {
    const { id } = req.params;
    const success = systemLogger.deleteEntry(id);
    res.json(success);
});

// add a message to the logger
app.post('/logger', (req, res) => {
    const { message } = req.body;
    systemLogger.log(message);
    res.send('ok');
});

app.get('/get-images/:offset/:limit', (req, res) => {
    const { offset, limit } = req.params;
    const images = imageData.slice(offset, offset + limit);
    res.json(images);
});

app.put('/imageData', async (req, res) => {
    const data = req.body;
    if (data.length > 0) res.send('ok');
    console.log(typeof data);
    console.log("Size of data: ", data.length, "\nCalling buildImageData()");
    imageData = buildImageData(data);
    console.log("Size of data: ", imageData.length, "\nDone building imageData\nUpdating database");
    for (let i = 0; i < imageData.length; i++) {
        // await insertUUID(imageData[i].id, i);
        if (updateDB) await insertImage_DB(imageData[i], i);
    }
    console.log("Done updating database");
});


/**
 * 
 * @param {*} data 
 * @returns 
 */
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

let axiosQueue = [];

const checkFileExists = (url) => {
    return new Promise((resolve, reject) => {
        let fileName = `output/all/${url.split('/')[4]}_${url.split('/')[5]}`;
        if (fs.existsSync(fileName)) {
            reject();
        } else {
            resolve();
        }
    });
}

async function processAxiosQueue() {
    // first thing to do is find all duplicate images
    // then remove them from the queue
    let uniqueQueue = Array.from(new Set(axiosQueue));

    let promises = [];
    let nonExistentImages = [];

    axiosQueue.forEach((url) => {
        promises.push(checkFileExists(url).then(() => { nonExistentImages.push(url) }).catch(() => { }));
    });

    await Promise.all(promises);

    while (nonExistentImages.length > 0) {
        process.stdout.cursorTo(0);
        process.stdout.moveCursor(0, 1);
        process.stdout.clearLine();
        process.stdout.write(`nonExistentImages.length: ${nonExistentImages.length} images\r`);
        process.stdout.moveCursor(0, -1);
        let url = nonExistentImages.shift();
        try {
            const response = await axios.get(url, { responseType: 'stream' });
            let fileName = `output/all/${url.split('/')[4]}_${url.split('/')[5]}`
            await response.data.pipe(fs.createWriteStream(fileName));
            await waitSeconds(0.1);
        } catch (error) {
            console.log(error);
            nonExistentImages.push(url);
        }
    }

    while (uniqueQueue.length > 0) {
        process.stdout.cursorTo(0);
        process.stdout.moveCursor(0, 1);
        process.stdout.clearLine();
        process.stdout.write(`uniqueQueue.length: ${uniqueQueue.length} images\r`);
        process.stdout.moveCursor(0, -1);
        let url = uniqueQueue.shift();
        try {
            const response = await axios.get(url, { responseType: 'stream' });
            let fileName = `output/all/${url.split('/')[4]}_${url.split('/')[5]}`;
            // check to see if file is same size as response
            const stats = fs.statSync(fileName);
            const fileSizeInBytes = stats.size;
            const contentLength = response.headers['content-length'];
            if (fileSizeInBytes != contentLength) {
                await response.data.pipe(fs.createWriteStream(fileName));
                await waitSeconds(0.1);
            }
        } catch (error) {
            console.log(error.cause);
            axiosQueue.push(url);
        }
    }
}

const waitSeconds = (seconds) => {
    return new Promise((resolve, reject) => {
        setTimeout(() => { resolve(); }, seconds * 1000);
    });
};

let servedImageCount = 0;

app.get('/image/:imageName', async (req, res) => {
    servedImageCount++;
    process.stdout.cursorTo(0);
    process.stdout.moveCursor(0, 1);
    process.stdout.clearLine();
    process.stdout.write(`Served ${servedImageCount} images\r`);
    process.stdout.moveCursor(0, -1);

    const { imageName } = req.params;
    const { width, height } = req.query;

    const imagePath = path.join(__dirname, 'output/all', imageName);

    // Ensure the file exists
    if (!fs.existsSync(imagePath)) {
        res.status(404).send('Image not found');
        return;
    }

    // Ensure the file is a PNG
    // const isPNG = await validatePNG(imagePath);
    // if (!isPNG) {
    //     res.status(400).send('Image is not a valid PNG');
    //     return;
    // }


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
            await image.resize(widthNum, heightNum, { fit: 'inside' });
        }

        // Output the image
        res.set('Content-Type', 'image/jpg');
        image.pipe(res);

    } catch (error) {
        console.error('Error processing image: ', { error });
        res.status(500).send('Server error');
    }
});


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

systemLogger.log("Server started");

process.stdin.on('data', function (data) {
    console.log(data.toString());
    if (data.toString().trim() === 'exit') {
        process.exit();
    }
    if (data.toString().trim() === 'ls') {
        console.log(JSON.stringify(checkArray, null, 2));
    }
});

process.exit = function (code) {
    console.log('exiting');
    dbClient.end();
    process.exit(code);
}