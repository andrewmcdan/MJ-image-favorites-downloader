"use strict";

const DEFAULT_REVIEW_LIMIT = 100;
const MAX_REVIEW_LIMIT = 1000;
const MAX_REVIEW_UPDATES = 10000;

function normalizeReviewPagination(limit, offset) {
    const parsedLimit = Number.parseInt(limit, 10);
    const parsedOffset = Number.parseInt(offset, 10);
    return {
        limit: Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_REVIEW_LIMIT) : DEFAULT_REVIEW_LIMIT,
        offset: Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0,
    };
}

const REVIEW_IMAGES_QUERY = `
    SELECT id, uuid, parent_uuid, grid_index, enqueue_time, full_command,
           width, height, storage_location, downloaded, do_not_download,
           processed, index, upscale_location
    FROM images
    WHERE processed = false
    ORDER BY enqueue_time DESC, id DESC
    LIMIT $1 OFFSET $2`;

const BULK_REVIEW_UPDATE_QUERY = `
    WITH requested_updates AS (
        SELECT *
        FROM unnest($1::text[], $2::boolean[]) AS update_row(uuid, do_not_download)
    )
    UPDATE images AS image
    SET do_not_download = requested_updates.do_not_download,
        processed = true
    FROM requested_updates
    WHERE image.uuid = requested_updates.uuid
    RETURNING image.uuid, image.do_not_download, image.processed`;

function normalizeReviewUpdates(updates, maximum = MAX_REVIEW_UPDATES) {
    if (!Array.isArray(updates)) return [];
    const normalized = new Map();
    for (const update of updates) {
        if (!update || typeof update.id !== "string" || typeof update.doNotDownload !== "boolean") continue;
        const id = update.id.trim();
        if (!id || id.length > 100) continue;
        normalized.set(id, { id, doNotDownload: update.doNotDownload });
        if (normalized.size >= maximum) break;
    }
    return [...normalized.values()];
}

module.exports = {
    DEFAULT_REVIEW_LIMIT,
    MAX_REVIEW_LIMIT,
    MAX_REVIEW_UPDATES,
    normalizeReviewPagination,
    normalizeReviewUpdates,
    REVIEW_IMAGES_QUERY,
    BULK_REVIEW_UPDATE_QUERY,
};
