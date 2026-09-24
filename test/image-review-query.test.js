"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    normalizeReviewPagination,
    normalizeReviewUpdates,
    REVIEW_IMAGES_QUERY,
    BULK_REVIEW_UPDATE_QUERY,
} = require("../src/services/image-review-query");

test("review pagination clamps limits and rejects invalid offsets", () => {
    assert.deepEqual(normalizeReviewPagination("250", "50"), { limit: 250, offset: 50 });
    assert.deepEqual(normalizeReviewPagination("5000", "-4"), { limit: 1000, offset: 0 });
    assert.deepEqual(normalizeReviewPagination("invalid", "invalid"), { limit: 100, offset: 0 });
});

test("review query filters processed images in PostgreSQL", () => {
    assert.match(REVIEW_IMAGES_QUERY, /WHERE processed = false/);
    assert.match(REVIEW_IMAGES_QUERY, /ORDER BY enqueue_time DESC, id DESC/);
    assert.doesNotMatch(REVIEW_IMAGES_QUERY, /SELECT \*/);
});

test("bulk review updates validate and deduplicate image IDs", () => {
    assert.deepEqual(
        normalizeReviewUpdates([
            { id: "job_0", doNotDownload: false },
            { id: "job_0", doNotDownload: true },
            { id: "job_1", doNotDownload: false },
            { id: "", doNotDownload: false },
            { id: "job_2", doNotDownload: "false" },
        ]),
        [
            { id: "job_0", doNotDownload: true },
            { id: "job_1", doNotDownload: false },
        ],
    );
    assert.match(BULK_REVIEW_UPDATE_QUERY, /unnest\(\$1::text\[\], \$2::boolean\[\]\)/);
    assert.match(BULK_REVIEW_UPDATE_QUERY, /processed = true/);
});
