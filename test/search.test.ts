/**
 * Tests for the search layer. Run with: node --test test/search.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Doc } from "../indexer.ts";
import { buildIndex, makeSnippet, search, tokenize } from "../search.ts";

function doc(text: string, role: Doc["role"] = "user"): Doc {
	return { id: Math.random().toString(36), sessionPath: "/s", role, text };
}

test("tokenize folds accents and case", () => {
	assert.deepEqual(tokenize("Search Wìdgets d'Update!"), ["search", "widgets", "d", "update"]);
});

test("exact match ranks first, results sorted by score", () => {
	const index = buildIndex([
		doc("we discussed the flaky deploy pipeline"),
		doc("pipeline pipeline pipeline everywhere"),
		doc("nothing to see here"),
	]);
	const hits = search(index, "pipeline");
	assert.equal(hits.length, 2);
	assert.equal(hits[0].doc.text, "pipeline pipeline pipeline everywhere");
});

test("prefix matching finds brew for brewin", () => {
	const index = buildIndex([doc("we launched brewin to test it")]);
	const hits = search(index, "brew");
	assert.equal(hits.length, 1);
});

test("accent-folded query matches accented text", () => {
	const index = buildIndex([doc("résumé of the wìdgets update")]);
	const hits = search(index, "resume widgets");
	assert.equal(hits.length, 1);
	assert.ok(hits[0].doc.text.includes("wìdgets"));
});

test("multi-token query requires every token (AND)", () => {
	const index = buildIndex([doc("update of the widgets dashboard"), doc("update of the reports"), doc("widgets and reports but without the refresh")]);
	const hits = search(index, "widgets update");
	assert.equal(hits.length, 1);
	assert.ok(hits[0].doc.text.includes("widgets dashboard"));
});

test("fuzzy subsequence matches workman for wrk", () => {
	const index = buildIndex([doc("the workman delivered on time")]);
	const hits = search(index, "wrkmn");
	assert.equal(hits.length, 1);
});

test("summaries rank below prompts on equal terms", () => {
	const index = buildIndex([doc("migration of the widgets", "summary"), doc("migration of the widgets", "user")]);
	const hits = search(index, "migration widgets");
	assert.equal(hits[0].doc.role, "user");
});

test("no results for empty or whitespace query", () => {
	const index = buildIndex([doc("some text")]);
	assert.deepEqual(search(index, ""), []);
	assert.deepEqual(search(index, "   "), []);
});

test("limit caps results", () => {
	const index = buildIndex(Array.from({ length: 50 }, (_, i) => doc(`session number ${i} about widgets`)));
	assert.equal(search(index, "widgets", 5).length, 5);
});

test("snippet wraps the match and truncates long text", () => {
	const text = `${"x".repeat(200)} the widget build is broken ${"y".repeat(200)}`;
	const snippet = makeSnippet(text, ["widget"]);
	assert.ok(snippet.includes("\x01widget\x02"));
	assert.ok(snippet.startsWith("…"));
	assert.ok(snippet.length < text.length / 2);
});

test("snippet marks accented match in original text", () => {
	const snippet = makeSnippet("here is the wìdgets summary", ["widgets"]);
	assert.ok(snippet.includes("wìdgets"));
	assert.ok(snippet.includes("\x01"));
});
