"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DROP_OBSOLETE_FULL_COMMAND_INDEX_QUERY } = require("../src/services/database");

test("startup removes the unsupported full-command B-tree index", () => {
    assert.match(DROP_OBSOLETE_FULL_COMMAND_INDEX_QUERY, /^DROP INDEX CONCURRENTLY IF EXISTS temp_table_full_command_idx$/i);
});
