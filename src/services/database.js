"use strict";

const pgClient = require("pg");
const { normalizeReviewPagination, REVIEW_IMAGES_QUERY, BULK_REVIEW_UPDATE_QUERY } = require("./image-review-query");
const { DEFAULT_UPSERT_BATCH_SIZE, BULK_UPSERT_IMAGES_QUERY, serializeImagesForUpsert, chunkItems } = require("./image-bulk-upsert");
const { RANDOM_DOWNLOADED_IMAGE_QUERY, RANDOM_ANY_IMAGE_QUERY } = require("./slideshow-query");
const { DEFAULT_DOWNLOAD_BATCH_SIZE, PENDING_DOWNLOADS_QUERY, normalizePositiveInteger } = require("./download-queue");

function createDatabaseClass({ DB_Error, log0, log1, log2, log5, log6 }) {
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
                if (typeof err === "string" && err.includes("Connection terminated unexpectedly")) this.dbClient.connect();
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
            log6("insertImage()\nindex: " + index + "\nimage: " + JSON.stringify(image));
            // find if image exists in database
            // if it does, update it
            this.systemLogger?.log("Inserting image into database. Image ID: " + image.id);
            if (image.id !== undefined) {
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
            }else{
                log0("insertImage() error: Image ID is undefined. Cannot insert image into database. Image: " + JSON.stringify(image));
            }
    
            // if it doesn't exist, insert it
            image.processed = false;
            if (image.grid_index === undefined || image.grid_index === null) {
                image.grid_index = -1;
            }
            if (image.parent_id === undefined || image.parent_id === null) {
                // for grid images, set the parent_id to the id of the first image in the grid
                image.parent_id = image.id + "_grid_0";
            }
            if (image.enqueue_time === undefined || image.enqueue_time === null) {
                image.enqueue_time = new Date();
            }
            if (image.fullCommand === undefined || image.fullCommand === null) {
                image.fullCommand = "";
            }
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
                        index,
                    ],
                );
            } catch (err) {
                log0("insertImage() error: Error inserting image into database. Image ID: " + image.id + "Error: " + err);
                new DB_Error("Error inserting image into database. Image ID: " + image.id + "Error: " + err);
                return null;
            }
            log6("insertImage() complete");
            return res;
        };

        bulkUpsertImages = async (images, batchSize = DEFAULT_UPSERT_BATCH_SIZE) => {
            log5("bulkUpsertImages() called");
            const serialized = serializeImagesForUpsert(images);
            const batches = chunkItems(serialized, batchSize);
            let updated = 0;
            try {
                for (const batch of batches) {
                    const res = await this.dbClient.query(BULK_UPSERT_IMAGES_QUERY, [JSON.stringify(batch)]);
                    updated += res.rowCount;
                }
                log2(`Bulk upserted ${updated} images in ${batches.length} database batches.`);
                return { updated, batches: batches.length };
            } catch (err) {
                log0("bulkUpsertImages() error: " + err);
                new DB_Error("Error bulk-upserting images");
                throw err;
            }
        };

        deleteObsoleteUnprocessedImages = async (uuids) => {
            const uniqueIds = [...new Set(Array.isArray(uuids) ? uuids.filter((uuid) => typeof uuid === "string" && uuid) : [])];
            if (uniqueIds.length === 0) return 0;
            try {
                const res = await this.dbClient.query(
                    `DELETE FROM images WHERE processed = false AND uuid = ANY($1::text[])`,
                    [uniqueIds],
                );
                log2(`Removed ${res.rowCount} obsolete single-output image rows.`);
                return res.rowCount;
            } catch (err) {
                log0("deleteObsoleteUnprocessedImages() error: " + err);
                new DB_Error("Error deleting obsolete single-output image rows");
                throw err;
            }
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
                const res = await this.dbClient.query(`SELECT * FROM images WHERE uuid = $1`, [uuid]);
    
                if (res.rows.length > 0) {
                    if (res.rows.length > 1) log1("lookupByUUID() warning: Multiple images found in database. Image ID: " + uuid);
                    log6("lookupByUUID() complete");
                    return res.rows[0];
                }
                log1("lookupByUUID() Image not found in database. Image ID: " + uuid);
                log6("lookupByUUID() complete");
                return undefined;
            } catch (err) {
                log0("lookupByUUID() error: Error looking up image in database. Image ID: " + uuid + "Error: " + err);
                new DB_Error("Error looking up image in database. Image ID: " + uuid);
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
                    res = await this.dbClient.query(RANDOM_DOWNLOADED_IMAGE_QUERY);
                } else {
                    res = await this.dbClient.query(RANDOM_ANY_IMAGE_QUERY);
                }
                log6("getRandomImage() res.rows.length: " + res.rows.length + " res.rows: " + JSON.stringify(res.rows));
                if (res.rows.length > 0) {
                    if (res.rows.length > 1) log1("getRandomImage() warning: Multiple images found in database.");
                    log6("getRandomImage() complete");
                    return res.rows[0];
                }
                log1("getRandomImage() Image not found in database.");
                log6("getRandomImage() complete");
                return undefined;
            } catch (err) {
                log0("getRandomImage() error: Error looking up random image in database. Error: " + err);
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
        lookupImagesByIndexRange = async (indexStart, indexEnd, processedOnly = { processed: false, enabled: false }, downloadedOnly = { downloaded: false, enabled: false }, do_not_downloadOnly = { do_not_download: false, enabled: false }) => {
            log5("lookupImagesByIndexRange() called");
            log6("lookupImagesByIndexRange()\nindexStart: " + indexStart + "\nindexEnd: " + indexEnd + "\nprocessedOnly: " + JSON.stringify(processedOnly) + "\ndownloadedOnly: " + JSON.stringify(downloadedOnly) + "\ndo_not_downloadOnly: " + JSON.stringify(do_not_downloadOnly));
            if (typeof indexStart === "number") indexStart = indexStart.toString();
            if (typeof indexStart === "string") {
                try {
                    indexStart = parseInt(indexStart);
                } catch {
                    log1("lookupImagesByIndexRange() unable to parse indexStart. indexStart: " + indexStart);
                    log6("lookupImagesByIndexRange() complete");
                    return null;
                }
                indexStart = indexStart.toString();
            } else {
                log1("lookupImagesByIndexRange() unable to parse indexStart. indexStart: " + indexStart);
                log6("lookupImagesByIndexRange() complete");
                return null;
            }
            if (typeof indexEnd === "number") indexEnd = indexEnd.toString();
            if (typeof indexEnd === "string") {
                try {
                    indexEnd = parseInt(indexEnd);
                } catch {
                    log1("lookupImagesByIndexRange() unable to parse indexEnd. indexEnd: " + indexEnd);
                    log6("lookupImagesByIndexRange() complete");
                    return null;
                }
                indexEnd = indexEnd.toString();
            } else {
                log1("lookupImagesByIndexRange() unable to parse indexEnd. indexEnd: " + indexEnd);
                log6("lookupImagesByIndexRange() complete");
                return null;
            }
            // at this point indexStart and indexEnd should be strings that are numbers. Anything else would have returned null
            try {
                let queryParts = ["SELECT * FROM images WHERE id >= $1 AND id < $2"];
                let queryParams = [indexStart, indexEnd];
    
                if (processedOnly.enabled === true) {
                    queryParts.push("AND processed = " + (processedOnly.processed === true ? "true" : "false"));
                    log6("lookupImagesByIndexRange() processedOnly enabled, processed: " + processedOnly.processed);
                }
                if (downloadedOnly.enabled === true) {
                    queryParts.push("AND downloaded = " + (downloadedOnly.downloaded === true ? "true" : "false"));
                    log6("lookupImagesByIndexRange() downloadedOnly enabled, downloaded: " + downloadedOnly.downloaded);
                }
                if (do_not_downloadOnly.enabled === true) {
                    queryParts.push("AND do_not_download = " + (do_not_downloadOnly.do_not_download === true ? "true" : "false"));
                    log6("lookupImagesByIndexRange() do_not_downloadOnly enabled, do_not_download: " + do_not_downloadOnly.do_not_download);
                }
    
                // log2(queryParts.join(' '), queryParams); // TODO: remove this
    
                const res = await this.dbClient.query(queryParts.join(" "), queryParams);
                log6("lookupImagesByIndexRange() res.rows.length: " + res.rows.length);
                if (res.rows.length > 0) {
                    log6("lookupImagesByIndexRange() complete");
                    return res.rows;
                }
                log1("lookupImagesByIndexRange() Images not found in database. Image index range: " + indexStart + " to " + indexEnd);
                log6("lookupImagesByIndexRange() complete");
                return undefined;
            } catch (err) {
                log0("lookupImagesByIndexRange() error: Error looking up images in database. Image index range: " + indexStart + " to " + indexEnd + "Error: " + err);
                new DB_Error("Error looking up images in database. Image index range: " + indexStart + " to " + indexEnd);
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
        lookupImageByIndex = async (index, processedOnly = { processed: false, enabled: false }, downloadedOnly = { downloaded: false, enabled: false }, do_not_downloadOnly = { do_not_download: false, enabled: false }) => {
            log5("lookupImageByIndex() called");
            log6("lookupImageByIndex()\nindex: " + index + "\nprocessedOnly: " + JSON.stringify(processedOnly) + "\ndownloadedOnly: " + JSON.stringify(downloadedOnly) + "\ndo_not_downloadOnly: " + JSON.stringify(do_not_downloadOnly));
            if (typeof index === "number") index = index.toString();
            if (typeof index === "string") {
                try {
                    index = parseInt(index);
                } catch {
                    log1("lookupImageByIndex() unable to parse index. index: " + index);
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
                    queryParts.push("AND processed = " + (processedOnly.processed === true ? "true" : "false"));
                    log6("lookupImageByIndex() processedOnly enabled, processed: " + processedOnly.processed);
                }
                if (downloadedOnly.enabled === true) {
                    queryParts.push("AND downloaded = " + (downloadedOnly.downloaded === true ? "true" : "false"));
                    log6("lookupImageByIndex() downloadedOnly enabled, downloaded: " + downloadedOnly.downloaded);
                }
                if (do_not_downloadOnly.enabled === true) {
                    queryParts.push("AND do_not_download = " + (do_not_downloadOnly.do_not_download === true ? "true" : "false"));
                    log6("lookupImageByIndex() do_not_downloadOnly enabled, do_not_download: " + do_not_downloadOnly.do_not_download);
                }
    
                queryParts.push("LIMIT 1");
    
                // log2(queryParts.join(' '), queryParams); // TODO: remove this
    
                const res = await this.dbClient.query(queryParts.join(" "), queryParams);
                if (res.rows.length == 1) {
                    log6("lookupImageByIndex() complete");
                    return res.rows[0];
                } else if (res.rows.length > 1) {
                    new DB_Error("Error looking up image in database. Too many rows returned. Image index: " + index);
                } else if (res.rows.length == 0) {
                    log1("lookupImageByIndex() Image not found in database. Image index: " + index);
                    log6("lookupImageByIndex() complete");
                    return undefined;
                }
                log1("lookupImageByIndex() Image not found in database. Image index: " + index);
                log6("lookupImageByIndex() complete");
                return undefined;
            } catch (err) {
                log0("lookupImageByIndex() error: Error looking up image in database. Image index: " + index + "Error: " + err);
                new DB_Error("Error looking up image in database. Image index: " + index);
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
                        image.parent_id !== null && image.parent_id !== undefined ? image.parent_id : image.parent_uuid !== null && image.parent_uuid !== undefined ? image.parent_uuid : null,
                        image.grid_index !== null && image.grid_index !== undefined ? image.grid_index : null,
                        image.enqueue_time !== null && image.enqueue_time !== undefined ? image.enqueue_time : null,
                        image.fullCommand !== null && image.fullCommand !== undefined ? image.fullCommand : null,
                        image.width !== null && image.width !== undefined ? image.width : null,
                        image.height !== null && image.height !== undefined ? image.height : null,
                        image.storageLocation !== null && image.storageLocation !== undefined ? image.storageLocation : image.storage_location !== null && image.storage_location !== undefined ? image.storage_location : null,
                        image.downloaded !== null && image.downloaded !== undefined ? image.downloaded : null,
                        image.doNotDownload !== null && image.doNotDownload !== undefined ? image.doNotDownload : null,
                        image.processed !== null && image.processed !== undefined ? image.processed : null,
                        image.upscale_location !== null && image.upscale_location !== undefined ? image.upscale_location : null,
                        image.id !== null && image.id !== undefined ? image.id : image.parent_uuid !== null && image.parent_uuid !== undefined && image.grid_index !== null && image.grid_index !== undefined ? image.parent_uuid + "_" + image.grid_index : null,
                    ],
                );
                log6("updateImage() complete");
                return res;
            } catch (err) {
                log0("updateImage() error: Error updating image in database. Image ID: " + image.id + "Error: " + err);
                new DB_Error("Error updating image in database. Image ID: " + image.id);
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
                const res = await this.dbClient.query(`DELETE FROM images WHERE uuid = $1`, [uuid]);
                log6("deleteImage() complete");
                return res;
            } catch (err) {
                log0("deleteImage() error: Error deleting image from database. Image ID: " + uuid + "Error: " + err);
                new DB_Error("Error deleting image from database. Image ID: " + uuid);
                log6("deleteImage() complete");
                return null;
            }
        };
        countImagesTotal = async () => {
            log5("countImagesTotal() called");
            try {
                const res = await this.dbClient.query(`SELECT COUNT(*) FROM images`);
                log6("countImagesTotal() complete");
                return res.rows[0].count;
            } catch (err) {
                log0("countImagesTotal() error: Error counting images in database. Error: " + err);
                new DB_Error("Error counting images in database");
                log6("countImagesTotal() complete");
                return null;
            }
        };
        countImagesDownloaded = async () => {
            log5("countImagesDownloaded() called");
            try {
                const res = await this.dbClient.query(`SELECT COUNT(*) FROM images WHERE downloaded = true`);
                log6("countImagesDownloaded() complete");
                return res.rows[0].count;
            } catch (err) {
                log0("countImagesDownloaded() error: Error counting downloaded images in database. Error: " + err);
                new DB_Error("Error counting downloaded images in database");
                log6("countImagesDownloaded() complete");
                return null;
            }
        };

        getPendingDownloadsAfterId = async (lastId = 0, limit = DEFAULT_DOWNLOAD_BATCH_SIZE) => {
            const safeLastId = Math.max(0, Number.parseInt(lastId, 10) || 0);
            const safeLimit = normalizePositiveInteger(limit, DEFAULT_DOWNLOAD_BATCH_SIZE);
            log5(`getPendingDownloadsAfterId() called after id ${safeLastId}, limit ${safeLimit}`);
            try {
                const res = await this.dbClient.query(PENDING_DOWNLOADS_QUERY, [safeLastId, safeLimit]);
                return res.rows;
            } catch (err) {
                log0("getPendingDownloadsAfterId() error: " + err);
                new DB_Error("Error getting pending downloads");
                return null;
            }
        };

        getDownloadedFileReferences = async () => {
            log5("getDownloadedFileReferences() called");
            try {
                const res = await this.dbClient.query(`
                    SELECT uuid, storage_location
                    FROM images
                    WHERE downloaded = true AND do_not_download = false
                    ORDER BY id
                `);
                return res.rows;
            } catch (err) {
                log0("getDownloadedFileReferences() error: " + err);
                new DB_Error("Error getting downloaded file references");
                return null;
            }
        };

        markDownloadsMissing = async (uuids) => {
            if (!Array.isArray(uuids) || uuids.length === 0) return 0;
            log5(`markDownloadsMissing() called for ${uuids.length} images`);
            try {
                const res = await this.dbClient.query(`
                    UPDATE images
                    SET downloaded = false
                    WHERE uuid = ANY($1::text[])
                `, [uuids]);
                return res.rowCount;
            } catch (err) {
                log0("markDownloadsMissing() error: " + err);
                new DB_Error("Error marking missing downloads");
                return null;
            }
        };
        setImageProcessed = async (uuid, valueBool = true) => {
            log5("setImageProcessed() called");
            log6("setImageProcessed()\nuuid: " + uuid + "\nvalueBool: " + valueBool);
            if (typeof valueBool === "string") valueBool = valueBool === "true";
            if (typeof valueBool !== "boolean") {
                log1("setImageProcessed() error: valueBool must be a boolean");
                log6("setImageProcessed() complete");
                return null;
            }
            try {
                const res = await this.dbClient.query(`UPDATE images SET processed = $1 WHERE uuid = $2`, [valueBool, uuid]);
                log6("setImageProcessed() complete");
                return res;
            } catch (err) {
                log0("setImageProcessed() error: Error setting image processed in database. Image ID: " + uuid + "Error: " + err);
                new DB_Error("Error setting image processed in database. Image ID: " + uuid);
                log6("setImageProcessed() complete");
                return null;
            }
        };

        updateImageReviewStatuses = async (updates) => {
            log5("updateImageReviewStatuses() called");
            if (!Array.isArray(updates) || updates.length === 0) return [];
            try {
                const ids = updates.map((update) => update.id);
                const doNotDownloadValues = updates.map((update) => update.doNotDownload);
                const res = await this.dbClient.query(BULK_REVIEW_UPDATE_QUERY, [ids, doNotDownloadValues]);
                log6("updateImageReviewStatuses() updated rows: " + res.rowCount);
                return res.rows;
            } catch (err) {
                log0("updateImageReviewStatuses() error: " + err);
                new DB_Error("Error bulk-updating image review statuses");
                return null;
            }
        };
        updateTimesSelectedPlusOne = async (uuid) => {
            log5("updateTimesSelectedPlusOne() called");
            log6("updateTimesSelectedPlusOne()\nuuid: " + uuid);
            try {
                // get times_selected for uuid
                let res = await this.dbClient.query(`SELECT times_selected FROM images WHERE uuid = $1`, [uuid]);
                let timesSelected = res.rows[0].times_selected;
                log6("updateTimesSelectedPlusOne() timesSelected: " + timesSelected);
                // add 1 to it
                timesSelected++;
                log6("updateTimesSelectedPlusOne() timesSelected: " + timesSelected);
                // update times_selected for uuid
                res = await this.dbClient.query(`UPDATE images SET times_selected = $1 WHERE uuid = $2`, [timesSelected, uuid]);
                log6("updateTimesSelectedPlusOne() complete");
            } catch (err) {
                log0("updateTimesSelectedPlusOne() error: Error updating times_selected in database. Image ID: " + uuid + "Error: " + err);
                new DB_Error("Error updating times_selected in database. Image ID: " + uuid);
                log6("updateTimesSelectedPlusOne() complete");
                return null;
            }
        };
    
        setAllImagesSelectedCountZero = async () => {
            log5("setAllImagesSelectedCountZero() called");
            try {
                const res = await this.dbClient.query(`UPDATE images SET times_selected = 0`);
                log6("setAllImagesSelectedCountZero() complete");
                return res;
            } catch (err) {
                log0("setAllImagesSelectedCountZero() error: Error setting all images selected count to zero. Error: " + err);
                new DB_Error("Error setting all images selected count to zero");
                log6("setAllImagesSelectedCountZero() complete");
                return null;
            }
        };
    
        getEntriesOrderedByEnqueueTime = async (limit = 100, offset = 0) => {
            log5("getEntriesOrderedByEnqueueTime() called");
            log6("getEntriesOrderedByEnqueueTime()\nlimit: " + limit + "\noffset: " + offset);
            ({ limit, offset } = normalizeReviewPagination(limit, offset));
            try {
                const res = await this.dbClient.query(REVIEW_IMAGES_QUERY, [limit, offset]);
                log6("getEntriesOrderedByEnqueueTime() res.rows.length: " + res.rows.length);
                log6("getEntriesOrderedByEnqueueTime() complete");
                return res.rows;
            } catch (err) {
                log0("getEntriesOrderedByEnqueueTime() error: Error getting entries ordered by enqueue_time. Error: " + err);
                new DB_Error("Error getting entries ordered by enqueue_time");
                log6("getEntriesOrderedByEnqueueTime() complete");
                return null;
            }
        };
    }

    return Database;
}

module.exports = { createDatabaseClass };
