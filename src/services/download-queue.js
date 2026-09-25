"use strict";

const DEFAULT_DOWNLOAD_BATCH_SIZE = 100;
const DEFAULT_DOWNLOAD_CONCURRENCY = 2;
const DOWNLOAD_RETRY_DELAYS_SECONDS = [60, 300];

const PENDING_DOWNLOADS_QUERY = `
    SELECT *
    FROM images
    WHERE processed = true
      AND downloaded = false
      AND do_not_download = false
      AND full_command !~* '--motion|--v[ =]+video'
      AND id > $1
    ORDER BY id ASC
    LIMIT $2`;

function normalizePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function runInConcurrentChunks(items, worker, concurrency = DEFAULT_DOWNLOAD_CONCURRENCY) {
    const safeItems = Array.isArray(items) ? items : [];
    const safeConcurrency = normalizePositiveInteger(concurrency, DEFAULT_DOWNLOAD_CONCURRENCY);
    const results = [];
    for (let index = 0; index < safeItems.length; index += safeConcurrency) {
        const chunk = safeItems.slice(index, index + safeConcurrency);
        results.push(...(await Promise.all(chunk.map(worker))));
    }
    return results;
}

module.exports = {
    DEFAULT_DOWNLOAD_BATCH_SIZE,
    DEFAULT_DOWNLOAD_CONCURRENCY,
    DOWNLOAD_RETRY_DELAYS_SECONDS,
    PENDING_DOWNLOADS_QUERY,
    normalizePositiveInteger,
    runInConcurrentChunks,
};
