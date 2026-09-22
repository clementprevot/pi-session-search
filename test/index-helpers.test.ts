/**
 * Tests for the session-path helpers in index.ts.
 * Run with: node --test test/index-helpers.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cwdDirName, headerCwd } from "../index.ts";

test("cwdDirName maps a cwd to pi's per-cwd directory name", () => {
	assert.equal(cwdDirName("/Users/me/Devs/my repo"), "--Users-me-Devs-my repo--");
	assert.equal(cwdDirName("/a/b:c"), "--a-b-c--");
	assert.equal(cwdDirName("relative/path"), "--relative-path--");
});

test("headerCwd reads the cwd from the session header line", () => {
	const dir = mkdtempSync(join(tmpdir(), "sesssearch-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, JSON.stringify({ type: "session", id: "abc", cwd: "/Users/me/project" }) + "\n");
	assert.equal(headerCwd(file), "/Users/me/project");
	rmSync(dir, { recursive: true, force: true });
});

test("headerCwd returns undefined for a file without a header", () => {
	const dir = mkdtempSync(join(tmpdir(), "sesssearch-"));
	const file = join(dir, "empty.jsonl");
	writeFileSync(file, "not json\n");
	assert.equal(headerCwd(file), undefined);
	assert.equal(headerCwd(join(dir, "missing.jsonl")), undefined);
	rmSync(dir, { recursive: true, force: true });
});
