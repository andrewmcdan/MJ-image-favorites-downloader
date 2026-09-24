"use strict";

const DEFAULT_PAGE_SIZE = 50;

function buildLikesUrl(page) {
    if (!Number.isInteger(page) || page < 1) throw new RangeError("Likes page must be a positive integer");
    return `/api/explore-likes?page=${page}&_ql=explore`;
}

function promptToCommand(job) {
    if (typeof job.full_command === "string" && job.full_command.trim()) return job.full_command.trim();
    if (typeof job.command === "string" && job.command.trim()) return job.command.trim();
    if (typeof job.prompt === "string") return job.prompt.trim();
    if (!job.prompt || typeof job.prompt !== "object") return "";

    const prompt = job.prompt;
    const parts = Array.isArray(prompt.decodedPrompt)
        ? prompt.decodedPrompt.map((part) => part?.content).filter(Boolean)
        : [];
    const parameters = [];

    if (prompt.ar?.w > 0 && prompt.ar?.h > 0) parameters.push(`--ar ${prompt.ar.w}:${prompt.ar.h}`);
    if (prompt.version) parameters.push(`--v ${prompt.version}`);
    if (prompt.stylize != null) parameters.push(`--s ${prompt.stylize}`);
    if (prompt.chaos != null) parameters.push(`--chaos ${prompt.chaos}`);
    if (prompt.weird != null) parameters.push(`--weird ${prompt.weird}`);
    if (prompt.quality != null) parameters.push(`--q ${prompt.quality}`);
    if (prompt.seed != null) parameters.push(`--seed ${prompt.seed}`);
    if (prompt.stop != null) parameters.push(`--stop ${prompt.stop}`);
    if (Array.isArray(prompt.no) && prompt.no.length) parameters.push(`--no ${prompt.no.join(",")}`);

    const styleRefs = Array.isArray(prompt.styleRef)
        ? prompt.styleRef.map((style) => style?.content).filter(Boolean)
        : [];
    if (styleRefs.length) parameters.push(`--sref ${styleRefs.join(" ")}`);
    if (prompt.sw != null) parameters.push(`--sw ${prompt.sw}`);
    if (prompt.sv != null) parameters.push(`--sv ${prompt.sv}`);
    if (prompt.tile) parameters.push("--tile");
    if (prompt.styleRaw) parameters.push("--style raw");

    return [...parts, ...parameters].join(" ").trim();
}

function getBatchSize(job) {
    if (Array.isArray(job.items) && job.items.length) return job.items.length;
    if (Number.isInteger(job.batch_size) && job.batch_size > 0) return job.batch_size;
    return 1;
}

function getLikedIndexes(job) {
    if (!Array.isArray(job.items)) return [];
    return job.items.reduce((indexes, item, index) => {
        if (item?.liked_by_user === true) indexes.push(index);
        return indexes;
    }, []);
}

function getEnqueueTime(job) {
    if (job.enqueue_time == null || job.enqueue_time === "") return new Date(0);
    if (typeof job.enqueue_time === "number") return new Date(job.enqueue_time);
    return new Date(job.enqueue_time);
}

function normalizeLikedJob(job) {
    if (!job || typeof job !== "object") throw new TypeError("Midjourney job must be an object");
    if (!job.id) throw new TypeError("Midjourney job is missing id");

    return {
        id: job.id,
        parentId: job.parent_id ?? null,
        jobType: job.job_type ?? "",
        eventType: job.event_type ?? "",
        batchSize: getBatchSize(job),
        likedIndexes: getLikedIndexes(job),
        enqueueTime: getEnqueueTime(job),
        fullCommand: promptToCommand(job),
        width: Number(job.width) || 0,
        height: Number(job.height) || 0,
        parentGrid: job.parent_grid,
    };
}

function isLastLikesPage(items) {
    return items.length === 0;
}

module.exports = {
    DEFAULT_PAGE_SIZE,
    buildLikesUrl,
    isLastLikesPage,
    getLikedIndexes,
    normalizeLikedJob,
    promptToCommand,
};
