"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    PENDING_DOWNLOADS_QUERY,
    normalizePositiveInteger,
    runInConcurrentChunks,
} = require("../src/services/download-queue");

test("pending download query selects eligible rows using keyset pagination", () => {
    assert.match(PENDING_DOWNLOADS_QUERY, /processed = true/i);
    assert.match(PENDING_DOWNLOADS_QUERY, /downloaded = false/i);
    assert.match(PENDING_DOWNLOADS_QUERY, /do_not_download = false/i);
    assert.match(PENDING_DOWNLOADS_QUERY, /id > \$1/i);
    assert.match(PENDING_DOWNLOADS_QUERY, /ORDER BY id ASC/i);
    assert.match(PENDING_DOWNLOADS_QUERY, /LIMIT \$2/i);
    assert.doesNotMatch(PENDING_DOWNLOADS_QUERY, /OFFSET/i);
});

test("positive integer normalization rejects invalid batch settings", () => {
    assert.equal(normalizePositiveInteger("25", 100), 25);
    assert.equal(normalizePositiveInteger(0, 100), 100);
    assert.equal(normalizePositiveInteger("bad", 100), 100);
});

test("concurrent chunk runner waits for each bounded group", async () => {
    let active = 0;
    let maximumActive = 0;
    const completed = [];
    const results = await runInConcurrentChunks([1, 2, 3, 4, 5], async (value) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        completed.push(value);
        active--;
        return value * 2;
    }, 2);

    assert.equal(maximumActive, 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(completed.length, 5);
});
