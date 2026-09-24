"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { findMissingDownloadIds, normalizeStoragePath } = require("../src/services/download-verification");

test("storage paths are normalized for the host operating system", () => {
    assert.equal(
        normalizeStoragePath("output\\2024\\1\\2\\image.png"),
        path.join("output", "2024", "1", "2", "image.png"),
    );
    assert.equal(
        normalizeStoragePath("output/2024/1/2/image.png"),
        path.join("output", "2024", "1", "2", "image.png"),
    );
});

test("download verification returns only missing file IDs", async () => {
    const records = [
        { uuid: "present", storage_location: "output/present.png" },
        { uuid: "missing", storage_location: "output/missing.png" },
        { uuid: "blank", storage_location: "" },
    ];
    const existing = new Set(["output/present.png"]);

    const missing = await findMissingDownloadIds(records, {
        fileExists: async (filePath) => existing.has(filePath),
    });

    assert.deepEqual(missing.sort(), ["blank", "missing"]);
});

test("download verification uses bounded concurrency", async () => {
    const records = Array.from({ length: 20 }, (_, index) => ({
        uuid: `image-${index}`,
        storage_location: `output/${index}.png`,
    }));
    let active = 0;
    let maximumActive = 0;

    await findMissingDownloadIds(records, {
        concurrency: 4,
        fileExists: async () => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolve) => setImmediate(resolve));
            active--;
            return true;
        },
    });

    assert.equal(maximumActive, 4);
});
