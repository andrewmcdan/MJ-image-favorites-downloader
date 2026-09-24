"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { normalizeReviewUpdates } = require("./services/image-review-query");

function registerRoutes({
    app,
    projectRoot,
    databaseUpdateManager,
    databaseUpdateManualData,
    imageDB,
    ImageInfo,
    downloadManager,
    upscalerManager,
    settings,
    systemLogger,
    serverStatusMonitor,
    saveSettings,
    log2,
    log3,
    log4,
    log6,
}) {
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
     * POST /updateDB_data
     * Updates the database with json data provided by the user
     */
    app.post("/updateDB_data", async (req, res) => {
        log3("POST /updateDB_data");
        const data = req.body;
        const success = await databaseUpdateManualData.update(data);
        res.json({ success });
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
     * Returns the next slideshow image as JSON. This avoids making slideshow
     * clients follow two redirects and download an HTML document per frame.
     */
    app.get("/api/slideshow/random/:dlOnly", async (req, res) => {
        const downloadedOnly = req.params.dlOnly === "true";
        let image;
        do {
            image = await imageDB.getRandomImage(downloadedOnly);
        } while (image === undefined || image === null);

        await imageDB.updateTimesSelectedPlusOne(image.uuid);
        res.json({
            uuid: image.uuid,
            parent_id: image.parent_uuid,
            grid_index: image.grid_index,
            enqueue_time: image.enqueue_time,
            fullCommand: image.full_command,
            width: image.width,
            height: image.height,
            storageLocation: image.storage_location,
            upscale_location: image.upscale_location,
        });
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
            const imageInfo = new ImageInfo(image.parent_uuid, image.grid_index, image.enqueue_time, image.full_command, image.width, image.height, image.storage_location, image.upscale_location);
            log6("updating times selected");
            imageDB.updateTimesSelectedPlusOne(uuid);
            log6("Sending html with image and json embedded");
            res.send(`<a href="/randomUUID"><img src="${imageInfo.urlFull}" /></a><script type="application/json">${JSON.stringify(imageInfo)}</script>`);
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
        const folders = fs.readdirSync("./").filter((file) => fs.lstatSync(path.join("./", file)).isDirectory());
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
        // log3("GET /loggerGet/:entries/:remove");
        const { entries, remove } = req.params;
        // log6("entries: " + entries);
        // log6("remove: " + remove);
        if (remove === "true") log2("removing entries from log");
        let log = systemLogger.getRecentEntries(entries, remove === "true");
        // log6("log: " + log);
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
        systemLogger?.log(message);
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

    app.post("/image/update-bulk", async (req, res) => {
        log3("POST /image/update-bulk");
        const updates = normalizeReviewUpdates(req.body?.updates);
        if (updates.length === 0) {
            res.status(400).json({ error: "No valid image updates were supplied" });
            return;
        }
        const updated = await imageDB.updateImageReviewStatuses(updates);
        if (updated === null) {
            res.status(500).json({ error: "Unable to update image metadata" });
            return;
        }
        res.json({ requested: updates.length, updated: updated.length, images: updated });
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
    app.get("/image/:imageUuid", async (req, res) => {
        log3("GET /image/:imageUuid");
        const { imageUuid } = req.params;
        const { width, height } = req.query;
        log6("imageUuid: " + imageUuid);
        log6("width: " + width);
        log6("height: " + height);
    
        const imagePath = path.join(projectRoot, "output", "all", imageUuid);
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
}

module.exports = { registerRoutes };
