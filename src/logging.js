"use strict";

const path = require("path");
const winston = require("winston");
require("winston-daily-rotate-file");

function createLogging({ logLevel, updateDB, verifyDownloadsOnStartup, projectRoot }) {
    const levelNames = ["error", "warn", "info", "http", "verbose", "debug", "silly"];
    const safeLevel = Number.isInteger(logLevel) && logLevel >= 0 && logLevel < levelNames.length ? logLevel : 0;
    const fileTransport = new winston.transports.DailyRotateFile({
        filename: path.join(projectRoot, "log", "%DATE%.log"),
        datePattern: "YYYY-MM-DD",
        maxSize: "10m",
        maxFiles: "1d",
    });
    const logger = winston.createLogger({
        level: levelNames[safeLevel],
        format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf((info) => `${info.timestamp} ${info.level}: ${info.message}`),
        ),
        transports: [new winston.transports.Console(), fileTransport],
    });

    const write = (level, ...args) => {
        const message = args.every((arg) => typeof arg === "string") ? args.join(" ") : JSON.stringify(args, null, 2);
        logger[levelNames[level]](message);
    };
    const logs = levelNames.map((_, index) => (...args) => write(index, ...args));

    logger[levelNames[safeLevel]]("Server Starting...");
    logger[levelNames[safeLevel]](`Log level set to ${levelNames[safeLevel]}`);
    logger[levelNames[safeLevel]](`Update DB set to ${updateDB}`);
    logger[levelNames[safeLevel]](`Verify Downloads on Startup set to ${verifyDownloadsOnStartup}`);

    const systemLogger = new SystemLogger(logger, logs);
    return { logger, systemLogger, log0: logs[0], log1: logs[1], log2: logs[2], log3: logs[3], log4: logs[4], log5: logs[5], log6: logs[6] };
}

class SystemLogger {
    constructor(logger, logs) {
        this.logger = logger;
        this.log5 = logs[5];
        this.log6 = logs[6];
        this.log1 = logs[1];
        this.logArr = [];
        this.idIndex = 0;
    }

    log(...message) {
        this.log5(`systemLogger.log called with message: ${message.join(" : ")}`);
        this.logger.log("error", message.join(" : "));
        const entry = { time: new Date(), message, id: this.idIndex++ };
        this.log6(`systemLogger.log entry: ${JSON.stringify(entry)}`);
        this.logArr.push(entry);
    }

    getLog() { return this.logArr; }
    clearLog() { this.logArr = []; }
    printLog() { console.log(this.logArr); }

    getMostRecentLog(remove = false) {
        if (this.logArr.length === 0) return null;
        const entry = this.logArr[this.logArr.length - 1];
        if (remove) this.logArr.pop();
        return entry;
    }

    getRecentEntries(numberOfEntries, remove = false) {
        const count = Math.min(Number.parseInt(numberOfEntries, 10), this.logArr.length);
        const entries = [];
        if (remove) this.log1(`Removing ${count} entries from systemLogger`);
        for (let index = 0; index < count; index++) {
            entries.push(remove ? this.getMostRecentLog(true) : this.logArr[this.logArr.length - 1 - index]);
        }
        return entries;
    }

    deleteEntry(id) {
        const numericId = typeof id === "string" ? Number.parseInt(id, 10) : id;
        const index = this.logArr.findIndex((entry) => entry.id === numericId);
        if (index < 0) return false;
        this.logArr.splice(index, 1);
        return true;
    }

    getNumberOfEntries() { return this.logArr.length; }
}

module.exports = { createLogging };
