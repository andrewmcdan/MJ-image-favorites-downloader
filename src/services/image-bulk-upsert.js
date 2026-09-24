"use strict";

const DEFAULT_UPSERT_BATCH_SIZE = 1000;

const BULK_UPSERT_IMAGES_QUERY = `
    INSERT INTO images (
        uuid, parent_uuid, grid_index, enqueue_time, full_command, width, height,
        storage_location, downloaded, do_not_download, processed, "index", upscale_location, liked
    )
    SELECT
        incoming.uuid, incoming.parent_uuid, incoming.grid_index, incoming.enqueue_time,
        incoming.full_command, incoming.width, incoming.height,
        '', false, false, false, incoming.image_index, null, incoming.liked
    FROM jsonb_to_recordset($1::jsonb) AS incoming(
        uuid text,
        parent_uuid uuid,
        grid_index integer,
        enqueue_time timestamp,
        full_command text,
        width integer,
        height integer,
        image_index integer,
        liked boolean
    )
    ON CONFLICT (uuid) DO UPDATE SET
        parent_uuid = EXCLUDED.parent_uuid,
        grid_index = EXCLUDED.grid_index,
        enqueue_time = EXCLUDED.enqueue_time,
        full_command = EXCLUDED.full_command,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        "index" = EXCLUDED."index",
        processed = CASE
            WHEN EXCLUDED.liked = true AND images.liked = false THEN false
            ELSE images.processed
        END,
        liked = images.liked OR EXCLUDED.liked
    RETURNING uuid`;

function serializeImagesForUpsert(images, startIndex = 0) {
    if (!Array.isArray(images)) return [];
    const serializedByUuid = new Map();
    images.forEach((image, offset) => {
        if (!image || typeof image.id !== "string" || !image.id) return;
        const serialized = {
            uuid: image.id,
            parent_uuid: image.parent_id ?? image.parent_uuid ?? null,
            grid_index: Number.isInteger(Number(image.grid_index)) ? Number(image.grid_index) : -1,
            enqueue_time: image.enqueue_time ?? new Date(),
            full_command: image.fullCommand ?? image.full_command ?? "",
            width: Number(image.width) || 0,
            height: Number(image.height) || 0,
            image_index: startIndex + offset,
            liked: image.liked === true,
        };
        // Midjourney can expose the same asset as both a legacy virtual upscale
        // and its canonical parent-grid image. PostgreSQL cannot upsert the same
        // UUID twice in one statement, so retain one canonical row before chunking.
        serializedByUuid.set(serialized.uuid, serialized);
    });
    return [...serializedByUuid.values()];
}

function chunkItems(items, batchSize = DEFAULT_UPSERT_BATCH_SIZE) {
    const safeBatchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_UPSERT_BATCH_SIZE;
    const chunks = [];
    for (let index = 0; index < items.length; index += safeBatchSize) chunks.push(items.slice(index, index + safeBatchSize));
    return chunks;
}

module.exports = { DEFAULT_UPSERT_BATCH_SIZE, BULK_UPSERT_IMAGES_QUERY, serializeImagesForUpsert, chunkItems };
