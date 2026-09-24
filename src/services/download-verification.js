"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_VERIFY_CONCURRENCY = 64;

function normalizeStoragePath(filePath) {
    if (typeof filePath !== "string") return "";
    return path.normalize(filePath.replace(/[\\/]+/g, path.sep));
}

async function isRegularFile(filePath) {
    const normalizedPath = normalizeStoragePath(filePath);
    if (normalizedPath.trim() === "") return false;
    try {
        return (await fs.promises.stat(normalizedPath)).isFile();
    } catch {
        return false;
    }
}

async function findMissingDownloadIds(records, options = {}) {
    if (!Array.isArray(records) || records.length === 0) return [];
    const fileExists = options.fileExists || isRegularFile;
    const requestedConcurrency = Number.parseInt(options.concurrency, 10);
    const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? requestedConcurrency
        : DEFAULT_VERIFY_CONCURRENCY;
    const missingIds = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < records.length) {
            const record = records[nextIndex++];
            if (!record || typeof record.uuid !== "string") continue;
            if (!(await fileExists(record.storage_location))) missingIds.push(record.uuid);
        }
    }

    const workerCount = Math.min(concurrency, records.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return missingIds;
}

module.exports = { DEFAULT_VERIFY_CONCURRENCY, findMissingDownloadIds, isRegularFile, normalizeStoragePath };
