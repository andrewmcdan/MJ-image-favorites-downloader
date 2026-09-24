"use strict";

const fs = require("fs");
const { PNG } = require("pngjs");

function waitSeconds(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function validatePNG(imagePath) {
    return new Promise((resolve) => {
        fs.createReadStream(imagePath)
            .pipe(new PNG())
            .on("parsed", () => resolve(true))
            .on("error", () => resolve(false));
    });
}

module.exports = { validatePNG, waitSeconds };
