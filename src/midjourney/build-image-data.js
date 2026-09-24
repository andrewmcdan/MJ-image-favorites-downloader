"use strict";

const { ImageInfo } = require("../models/image-info");
const { normalizeLikedJob } = require("./likes");

function buildImageData(data, options = {}) {
    const { debug = () => {}, trace = () => {}, likedOnly = false } = options;
    debug("buildImageData() called");
    trace(`buildImageData()\ndata.length: ${data.length}`);

    const imageData = [];
    data.forEach((job) => {
        trace(`Processing job: ${JSON.stringify(job)}`);
        const normalizedJob = normalizeLikedJob(job);
        if (isVirtualUpsample(normalizedJob)) {
            const parentGrid = Number(normalizedJob.parentGrid);
            if (normalizedJob.parentId && Number.isInteger(parentGrid)) {
                imageData.push(toImageInfo({ ...normalizedJob, id: normalizedJob.parentId }, parentGrid));
            }
            return;
        }
        if (likedOnly && normalizedJob.likedIndexes.length) {
            normalizedJob.likedIndexes.forEach((index) => {
                const image = toImageInfo(normalizedJob, index);
                image.liked = true;
                imageData.push(image);
            });
            return;
        }
        if (normalizedJob.batchSize > 1) {
            for (let index = 0; index < normalizedJob.batchSize; index++) {
                imageData.push(toImageInfo(normalizedJob, index));
            }
        } else {
            // parent_grid identifies the source quadrant for variations/upscales.
            // A single-output job still stores its own result at 0_0 on the CDN.
            imageData.push(toImageInfo(normalizedJob, 0));
        }
    });
    return imageData;
}

function isVirtualUpsample(job) {
    return String(job.jobType).includes("virtual_upsample") || String(job.eventType).includes("virtual");
}

function toImageInfo(job, gridIndex) {
    return new ImageInfo(job.id, gridIndex, job.enqueueTime, job.fullCommand, job.width, job.height);
}

function getObsoleteSingleOutputIds(data) {
    if (!Array.isArray(data)) return [];
    return data.flatMap((job) => {
        const normalizedJob = normalizeLikedJob(job);
        const parentGrid = Number(normalizedJob.parentGrid);
        if (isVirtualUpsample(normalizedJob)) {
            const obsoleteIds = [`${normalizedJob.id}_0`];
            if (Number.isInteger(parentGrid) && parentGrid !== 0) obsoleteIds.push(`${normalizedJob.id}_${parentGrid}`);
            return obsoleteIds;
        }
        if (normalizedJob.batchSize !== 1 || !Number.isInteger(parentGrid) || parentGrid === 0) return [];
        return [`${normalizedJob.id}_${parentGrid}`];
    });
}

module.exports = { buildImageData, getObsoleteSingleOutputIds, isVirtualUpsample };
