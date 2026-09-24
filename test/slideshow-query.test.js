"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { RANDOM_DOWNLOADED_IMAGE_QUERY, RANDOM_ANY_IMAGE_QUERY } = require("../src/services/slideshow-query");

test("slideshow selects the lowest times_selected value before randomizing ties", () => {
    for (const query of [RANDOM_DOWNLOADED_IMAGE_QUERY, RANDOM_ANY_IMAGE_QUERY]) {
        assert.match(query, /ORDER BY times_selected ASC, RANDOM\(\)/i);
        assert.doesNotMatch(query, /RANDOM\(\)\s*\//i);
    }
});

test("downloaded slideshow excludes unavailable and rejected images", () => {
    assert.match(RANDOM_DOWNLOADED_IMAGE_QUERY, /downloaded = true/i);
    assert.match(RANDOM_DOWNLOADED_IMAGE_QUERY, /do_not_download = false/i);
});
