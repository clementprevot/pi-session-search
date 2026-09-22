/**
 * Persistence for the session-search index.
 *
 * State lives in ~/.pi/agent/session-search/ (machine-local, same tier as
 * sessions-archive): meta.json (per-file scan state) and docs.jsonl
 * (append-only documents plus {"purge": path} markers). Loaders apply purge
 * markers and drop documents whose session path is absent from meta
 * (tombstoned or deleted sessions). Compaction rewrites docs.jsonl keeping
 * only live documents.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { emptyMeta, scanRoots, type DocRecord, type ExtractOptions, type SessionMeta } from "./indexer.ts";
import type { Doc } from "./indexer.ts";

export interface StorePaths {
	dir: string;
	meta: string;
	docs: string;
}

export function storePaths(stateDir: string): StorePaths {
	return { dir: stateDir, meta: join(stateDir, "meta.json"), docs: join(stateDir, "docs.jsonl") };
}

export function loadMeta(paths: StorePaths): SessionMeta {
	try {
		const parsed = JSON.parse(readFileSync(paths.meta, "utf8")) as SessionMeta;
		if (parsed.version === 1 && parsed.sessions) return parsed;
	} catch {
		// missing or corrupt: start fresh, docs.jsonl gets compacted away
	}
	return emptyMeta();
}

export function saveMeta(paths: StorePaths, meta: SessionMeta): void {
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.meta, JSON.stringify(meta));
}

/** Append scan records to docs.jsonl (purge markers included, in order). */
export function appendRecords(paths: StorePaths, records: DocRecord[]): void {
	if (records.length === 0) return;
	mkdirSync(paths.dir, { recursive: true });
	const payload = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
	writeFileSync(paths.docs, payload, { flag: "a" });
}

/**
 * Load the searchable document set: every Doc from docs.jsonl, honoring
 * purge markers, and keeping only sessions present in meta.
 */
export function loadDocs(paths: StorePaths, meta: SessionMeta): Doc[] {
	const docs: Doc[] = [];
	if (existsSync(paths.docs)) {
		for (const line of readFileSync(paths.docs, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line);
				if (typeof record.purge === "string") {
					// Drop earlier documents for that path; later re-appended docs survive.
					for (let i = docs.length - 1; i >= 0; i--) {
						if (docs[i].sessionPath === record.purge) docs.splice(i, 1);
					}
				} else if (record.text !== undefined) {
					docs.push(record as Doc);
				}
			} catch {
				// tolerate a torn final line; the append model self-heals on compaction
			}
		}
	}
	return docs.filter((d) => d.sessionPath in meta.sessions);
}

/** Rewrite docs.jsonl without purged/tombstoned content. */
export function compact(paths: StorePaths, meta: SessionMeta): void {
	const live = loadDocs(paths, meta);
	const tmp = `${paths.docs}.tmp`;
	writeFileSync(tmp, live.map((d) => JSON.stringify(d)).join("\n") + "\n");
	renameSync(tmp, paths.docs);
}

/**
 * Tombstones (purge markers) as a share of the docs file; past the threshold
 * the next scan triggers a compaction.
 */
export function wasteRatio(paths: StorePaths, meta: SessionMeta): number {
	if (!existsSync(paths.docs)) return 0;
	let total = 0;
	let dead = 0;
	for (const line of readFileSync(paths.docs, "utf8").split("\n")) {
		if (!line.trim()) continue;
		total += 1;
		try {
			const record = JSON.parse(line);
			if (typeof record.purge === "string" || !(record.sessionPath in meta.sessions)) dead += 1;
		} catch {
			dead += 1;
		}
	}
	return total === 0 ? 0 : dead / total;
}

export interface ScanResult {
	sessionsFound: number;
	recordsAppended: number;
	compacted: boolean;
}

/**
 * One incremental scan pass over the given roots: read, append new records,
 * persist meta, compact lazily. Safe to call on every picker open.
 */
export async function runScan(paths: StorePaths, roots: string[], options: ExtractOptions = {}): Promise<ScanResult> {
	const meta = loadMeta(paths);
	const outcome = await scanRoots(roots, meta, options);
	mkdirSync(paths.dir, { recursive: true });
	if (outcome.records.length > 0) appendRecords(paths, outcome.records);
	saveMeta(paths, outcome.meta);
	let compacted = false;
	if (wasteRatio(paths, outcome.meta) > 0.1) {
		compact(paths, outcome.meta);
		compacted = true;
	}
	return { sessionsFound: Object.keys(outcome.meta.sessions).length, recordsAppended: outcome.records.length, compacted };
}

export function fileMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
