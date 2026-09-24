"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { BULK_UPSERT_IMAGES_QUERY, serializeImagesForUpsert, chunkItems } = require("../src/services/image-bulk-upsert");

test("bulk upsert serialization preserves Midjourney metadata", () => {
    const rows = serializeImagesForUpsert([{
        id: "job-id_2",
        parent_id: "job-id",
        grid_index: 2,
        enqueue_time: "2026-09-23T22:30:16.054Z",
        fullCommand: "a robot",
        width: 1024,
        height: 1024,
    }]);
    assert.deepEqual(rows, [{
        uuid: "job-id_2",
        parent_uuid: "job-id",
        grid_index: 2,
        enqueue_time: "2026-09-23T22:30:16.054Z",
        full_command: "a robot",
        width: 1024,
        height: 1024,
        image_index: 0,
        liked: false,
    }]);
});

test("bulk upsert chunks records and preserves operational state on conflict", () => {
    assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.match(BULK_UPSERT_IMAGES_QUERY, /jsonb_to_recordset/);
    assert.match(BULK_UPSERT_IMAGES_QUERY, /ON CONFLICT \(uuid\) DO UPDATE/);
    assert.doesNotMatch(BULK_UPSERT_IMAGES_QUERY, /processed = EXCLUDED\.processed/);
    assert.doesNotMatch(BULK_UPSERT_IMAGES_QUERY, /downloaded = EXCLUDED\.downloaded/);
    assert.match(BULK_UPSERT_IMAGES_QUERY, /EXCLUDED\.liked = true AND images\.liked = false/);
    assert.match(BULK_UPSERT_IMAGES_QUERY, /liked = images\.liked OR EXCLUDED\.liked/);
});

test("bulk upsert serialization removes duplicate UUIDs before batching", () => {
    const rows = serializeImagesForUpsert([
        { id: "shared-job_2", parent_id: "shared-job", grid_index: 2, fullCommand: "virtual alias" },
        { id: "other-job_0", parent_id: "other-job", grid_index: 0, fullCommand: "other" },
        { id: "shared-job_2", parent_id: "shared-job", grid_index: 2, fullCommand: "canonical parent" },
    ]);

    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.uuid === "shared-job_2").full_command, "canonical parent");
    assert.equal(chunkItems(rows, 1).length, 2);
});
