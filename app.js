/**
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
 * 1. Add ExifTool capability to add metadata to images
 * 2. Add upscale capability to images using Ai-Upscale-Module
 * 3. Parse the output folder and omit images that have already been processed
 *      - This will require a database to store the image names, possibly just a json file
 * 
 */
//
const AdmZip = require('adm-zip');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const express = require('express');
const sharp = require('sharp');
const PNG = require('pngjs').PNG;
const app = express();
const port = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files from the "public" directory
app.use(express.static('public'));
app.use(express.static('output'));

let checkArray = [];
let xArray = [];

let imageData = [];
// get list of all files in zips directory
try {
    if (fs.existsSync('./zips')) {
        const files = fs.readdirSync('./zips');
        // console.log(files);
        files.forEach((file) => {
            const zipFilePath = path.join('./zips', file);
            if (!zipFilePath.endsWith('.zip')) return;
            const data = extractJsonData(zipFilePath);
            imageData.push(...data);
        });
    }
} catch (err) {
    console.log(err);
}

function extractJsonData(zipFilePath) {
    const zip = new AdmZip(zipFilePath);
    const zipEntries = zip.getEntries();

    let allData = [];

    zipEntries.forEach((zipEntry) => {
        if (zipEntry.entryName.endsWith('.json')) {
            const jsonData = zipEntry.getData().toString('utf8');
            const data = JSON.parse(jsonData);
            allData.push(...data);
        }
    });

    return allData;
}

async function downloadImages(images, location) {
    for (let image of images) {
        const response = await axios.get(image, { responseType: 'stream' });
        // https://storage.googleapis.com/dream-machines-output/53ae5df3-edef-4adb-a4c2-586de79edfe9/0_0.png
        let splitImage = image.split('/');
        splitImage = splitImage[splitImage.length - 2] + splitImage[splitImage.length - 1];
        response.data.pipe(fs.createWriteStream(path.join(location, splitImage)));
    }
}


app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});

app.post('/download-selected', (req, res) => {

    console.log(req.body);
    const { images, location } = req.body;
    console.log({ images });
    console.log({ location });
    downloadImages(images, location);
    res.send('Download initiated');
});

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.set('view engine', 'ejs');

app.get('/images', (req, res) => {
    res.render('images', { imageData });
    // reset checkArray and xArray on page load
    checkArray = [];
    xArray = [];
});

app.get('/available-folders', (req, res) => {
    const folders = fs.readdirSync('./').filter(file => fs.lstatSync(path.join('./', file)).isDirectory());
    res.json(folders);
});

app.get('/download-all', (req, res) => {
    imageData.forEach((image) => {
        image.image_paths.forEach((url) => {
            axiosQueue.push(url);
        });
    });
    res.send('Download initiated');
    processAxiosQueue();
});

app.get('/handle-MJ-data/*', (req, res) => {
    const data = req.body;
    console.log({ data });
    res.send('ok');
});

app.post('/handle-check', (req, res) => {
    const imageUrl = req.body.imageUrl;
    const imageInfo = findImageInfo(imageUrl);
    if (imageInfo) {
        checkArray.push(imageInfo);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/handle-x', (req, res) => {
    const imageUrl = req.body.imageUrl;
    if (imageUrl) {
        xArray.push({ url: imageUrl });
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/handle-reset', (req, res) => {
    const imageUrl = req.body.imageUrl;
    if (imageUrl) {
        // find in xArray and remove
        let index = xArray.findIndex((image) => {
            return image === imageUrl;
        });
        if (index > -1) {
            xArray.splice(index, 1);
        }
        // find in checkArray and remove
        index = checkArray.findIndex((image) => {
            return image.image_url === imageUrl;
        });
        if (index > -1) {
            checkArray.splice(index, 1);
        }
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

function findImageInfo(url) {
    // Assume data is the object that was originally sent to the client
    for (const item of imageData) {
        for (const image of item.image_paths) {
            if (image === url) {
                console.log('found image');
                // console.log({image});
                // console.log(item);
                return {
                    // ... build your object based on image data ...
                    image_url: image,
                    prompt: item.prompt,
                    full_command: item.full_command,
                    params:{
                        chaos: item._parsed_params.chaos,
                        style: item._parsed_params.style,
                        aspect: item._parsed_params.aspect,
                        no: item._parsed_params.no
                    },
                    job_time: item.enqueue_time,
                    image:{
                        width: item.event.width,
                        height: item.event.height
                    },
                    imagePrompts: item.event.imagePrompts,
                    textPrompts: item.event.textPrompt,
                    uuid: item.id,
                    siblings: item.image_paths
                };
            }
        }
    }
    return null;
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

process.stdin.on('data', function (data) {
    console.log(data.toString());
    if (data.toString().trim() === 'exit') {
        process.exit();
    }
    if(data.toString().trim() === 'ls'){
        console.log(JSON.stringify(checkArray, null, 2));
    }
});