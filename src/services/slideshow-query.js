"use strict";

const RANDOM_DOWNLOADED_IMAGE_QUERY = `
    SELECT *
    FROM images
    WHERE downloaded = true AND do_not_download = false
    ORDER BY times_selected ASC, RANDOM()
    LIMIT 1`;

const RANDOM_ANY_IMAGE_QUERY = `
    SELECT *
    FROM images
    ORDER BY times_selected ASC, RANDOM()
    LIMIT 1`;

module.exports = { RANDOM_DOWNLOADED_IMAGE_QUERY, RANDOM_ANY_IMAGE_QUERY };
