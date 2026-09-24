"use strict";

class ImageInfo {
    constructor(parentId, gridIndex, enqueueTime, fullCommand, width, height, storageLocation = "", upscaleLocation = "") {
        this.parent_id = parentId;
        this.grid_index = gridIndex;
        this.enqueue_time = enqueueTime;
        this.fullCommand = fullCommand;
        this.upscale_location = upscaleLocation;
        this.width = width;
        this.height = height;
        this.storageLocation = storageLocation;
        this.downloaded = null;
        this.doNotDownload = null;
        this.processed = null;
    }

    toJSON() {
        return {
            ...this,
            urlFull: this.urlFull,
            urlSmall: this.urlSmall,
            urlMedium: this.urlMedium,
            urlAlt: this.urlAlt,
            urlParentGrid: this.urlParentGrid,
        };
    }

    get id() {
        return `${this.parent_id}_${this.grid_index}`;
    }

    get urlFull() {
        return `https://cdn.midjourney.com/${this.parent_id}/0_${this.grid_index}.png`;
    }

    get urlSmall() {
        return `https://cdn.midjourney.com/${this.parent_id}/0_${this.grid_index}_32_N.webp`;
    }

    get urlMedium() {
        return `https://cdn.midjourney.com/${this.parent_id}/0_${this.grid_index}_384_N.webp?method=shortest`;
    }

    get urlAlt() {
        return `https://storage.googleapis.com/dream-machines-output/${this.parent_id}/0_${this.grid_index}.png`;
    }

    get urlParentGrid() {
        return `https://cdn.midjourney.com/${this.parent_id}/grid_0.webp`;
    }
}

module.exports = { ImageInfo };
