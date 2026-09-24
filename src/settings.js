"use strict";

const fs = require("fs");

function loadSettings(settingsPath) {
    if (!fs.existsSync(settingsPath)) return null;
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function saveSettings(settingsPath, settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

module.exports = { loadSettings, saveSettings };
