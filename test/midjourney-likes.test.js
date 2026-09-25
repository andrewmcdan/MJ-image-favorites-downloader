"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    buildLikesUrl,
    isLastLikesPage,
    normalizeLikedJob,
    promptToCommand,
} = require("../src/midjourney/likes");
const { buildImageData, getObsoleteSingleOutputIds } = require("../src/midjourney/build-image-data");

test("buildLikesUrl uses the current one-based likes endpoint", () => {
    assert.equal(buildLikesUrl(1), "/api/explore-likes?page=1&_ql=explore");
    assert.throws(() => buildLikesUrl(0), RangeError);
});

test("normalizes the current Explore response shape", () => {
    const result = normalizeLikedJob({
        id: "faa458f2-29ae-4129-9e12-dbd0f7dd4b8c",
        width: 1856,
        height: 2592,
        enqueue_time: 1780673713270,
        items: [{ liked_by_user: true }, {}, {}, {}],
        prompt: {
            decodedPrompt: [{ content: "A grid of dogs" }],
            version: "8.1",
            ar: { w: 5, h: 7 },
            stylize: 250,
            styleRef: [{ content: "https://s.mj.run/example" }],
            sw: 100,
            styleRaw: true,
        },
    });

    assert.equal(result.batchSize, 4);
    assert.deepEqual(result.likedIndexes, [0]);
    assert.equal(result.enqueueTime.toISOString(), "2026-06-05T15:35:13.270Z");
    assert.equal(
        result.fullCommand,
        "A grid of dogs --ar 5:7 --v 8.1 --s 250 --sref https://s.mj.run/example --sw 100 --style raw",
    );
});

test("keeps compatibility with legacy job payloads", () => {
    const result = normalizeLikedJob({
        id: "legacy-id",
        batch_size: 4,
        enqueue_time: "2024-01-02T03:04:05Z",
        full_command: "a legacy prompt --v 6",
        width: 1024,
        height: 1024,
    });

    assert.equal(result.batchSize, 4);
    assert.equal(result.fullCommand, "a legacy prompt --v 6");
    assert.equal(result.enqueueTime.toISOString(), "2024-01-02T03:04:05.000Z");
});

test("prompt parser accepts plain strings and pagination detects the final page", () => {
    assert.equal(promptToCommand({ prompt: "plain prompt" }), "plain prompt");
    assert.equal(isLastLikesPage(new Array(50)), false);
    assert.equal(isLastLikesPage(new Array(12)), false);
    assert.equal(isLastLikesPage([]), true);
});

test("buildImageData creates one ImageInfo per current API item", () => {
    const images = buildImageData([
        {
            id: "job-id",
            enqueue_time: 1780673713270,
            width: 1024,
            height: 1024,
            items: [{}, {}],
            prompt: { decodedPrompt: [{ content: "two images" }] },
        },
    ]);

    assert.equal(images.length, 2);
    assert.equal(images[0].id, "job-id_0");
    assert.equal(images[1].urlFull, "https://cdn.midjourney.com/job-id/0_1.png");
    assert.equal(images[0].fullCommand, "two images");
});

test("prompt image references do not replace generated output URLs", () => {
    const images = buildImageData([
        {
            id: "generated-job-id",
            enqueue_time: 1780673713270,
            width: 1024,
            height: 1024,
            items: [{}],
            prompt: { decodedPrompt: [{ content: "https://s.mj.run/source-ref a robot" }] },
        },
    ]);

    assert.equal(images[0].fullCommand, "https://s.mj.run/source-ref a robot");
    assert.equal(images[0].urlFull, "https://cdn.midjourney.com/generated-job-id/0_0.png");
    assert.equal(images[0].urlJpeg, "https://cdn.midjourney.com/generated-job-id/0_0.jpeg");

    const imagesView = fs.readFileSync(path.join(__dirname, "..", "views", "images.ejs"), "utf8");
    assert.doesNotMatch(imagesView, /return match\[1\]/);
    assert.match(imagesView, /retry=\$\{Date\.now\(\)\}/);
    assert.match(imagesView, /imgElement\.src = image\.urlFull/);
});

test("likes import includes only quadrants liked by the user", () => {
    const images = buildImageData(
        [
            {
                id: "liked-job",
                enqueue_time: 1780673713270,
                width: 1024,
                height: 1024,
                items: [
                    { liked_by_user: false },
                    { liked_by_user: true },
                    { liked_by_user: false },
                    { liked_by_user: true },
                ],
                prompt: "selected quadrants",
            },
        ],
        { likedOnly: true },
    );

    assert.deepEqual(images.map((image) => image.id), ["liked-job_1", "liked-job_3"]);
    assert.equal(images[0].liked, true);
    assert.equal(images[0].urlMedium, "https://cdn.midjourney.com/liked-job/0_1_384_N.webp?method=shortest");
    assert.equal(images[0].urlFull, "https://cdn.midjourney.com/liked-job/0_1.png");
});

test("single-output upscales use output index zero rather than the parent grid", () => {
    const images = buildImageData([{
        id: "upscale-job",
        parent_id: "source-grid",
        parent_grid: 3,
        batch_size: 1,
        enqueue_time: "2024-12-02T18:55:43.714827Z",
        full_command: "upscaled image",
        width: 2688,
        height: 1792,
    }]);

    assert.equal(images[0].id, "upscale-job_0");
    assert.equal(images[0].urlFull, "https://cdn.midjourney.com/upscale-job/0_0.png");
    assert.equal(images[0].urlMedium, "https://cdn.midjourney.com/upscale-job/0_0_384_N.webp?method=shortest");
    assert.deepEqual(getObsoleteSingleOutputIds([{
        id: "upscale-job",
        parent_grid: 3,
        batch_size: 1,
    }]), ["upscale-job_3"]);
});

test("legacy virtual upscales resolve to their parent grid asset", () => {
    const job = {
        id: "virtual-job",
        parent_id: "source-job",
        parent_grid: 2,
        batch_size: 1,
        job_type: "v6_virtual_upsample",
        event_type: "diffusion_upsample_v6_virtual",
        enqueue_time: "2024-02-26T06:12:10.643297Z",
        full_command: "glitchy reality --v 6.0",
        width: 1456,
        height: 816,
    };
    const images = buildImageData([job]);

    assert.equal(images[0].id, "source-job_2");
    assert.equal(images[0].urlFull, "https://cdn.midjourney.com/source-job/0_2.png");
    assert.equal(images[0].urlMedium, "https://cdn.midjourney.com/source-job/0_2_384_N.webp?method=shortest");
    assert.deepEqual(getObsoleteSingleOutputIds([job]), ["virtual-job_0", "virtual-job_2"]);
});
