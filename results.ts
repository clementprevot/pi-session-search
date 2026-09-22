/**
 * Turn ranked document hits into one result per session for the picker.
 * Pure logic, tested separately from the TUI.
 */

import type { Doc, SessionMeta } from "./indexer.ts";
import type { SearchHit } from "./search.ts";

export interface SessionResult {
	path: string;
	/** Display name: session_info name, else first prompt, else "(unnamed)". */
	name: string;
	cwd?: string;
	mtimeMs: number;
	snippet: string;
	bestScore: number;
	bestRole: Doc["role"];
	rounds: number;
	/** Entry id of the best matching document (for jump-to-round). */
	entryId?: string;
	/** Full text of the best matching document (for preview). */
	fullText: string;
}

export interface GroupOptions {
	/** Session paths starting with one of these are dropped when false. */
	includeExtraRoots: boolean;
	extraRoots: string[];
	/** Only sessions born in this cwd (undefined = all). */
	currentCwd?: string;
}

export function groupHits(hits: SearchHit[], meta: SessionMeta, options: GroupOptions): SessionResult[] {
	const best = new Map<string, SearchHit>();
	for (const hit of hits) {
		const entry = meta.sessions[hit.doc.sessionPath];
		if (!entry) continue;
		if (options.currentCwd && entry.cwd && entry.cwd !== options.currentCwd) continue;
		if (
			!options.includeExtraRoots &&
			options.extraRoots.some((root) => hit.doc.sessionPath.startsWith(root))
		) {
			continue;
		}
		const previous = best.get(hit.doc.sessionPath);
		if (!previous || hit.score > previous.score) best.set(hit.doc.sessionPath, hit);
	}

	const results: SessionResult[] = [];
	for (const [path, hit] of best) {
		const entry = meta.sessions[path];
		results.push({
			path,
			name: entry.name || entry.firstPrompt || "(unnamed)",
			cwd: entry.cwd,
			mtimeMs: entry.mtimeMs,
			snippet: hit.snippet,
			bestScore: hit.score,
			bestRole: hit.doc.role,
			rounds: entry.rounds,
			entryId: hit.doc.entryId,
			fullText: hit.doc.text,
		});
	}
	return results;
}

/** Strip \x01..\x02 snippet markers for plain-text display. */
export function stripSnippetMarkers(snippet: string): string {
	return snippet.replaceAll("\x01", "").replaceAll("\x02", "");
}

export interface RootLabel {
	path: string;
	label: string;
}

/** Label of the index root a session file lives under (longest prefix wins). */
export function labelForRoot(path: string, roots: RootLabel[], fallback = "sessions"): string {
	let best: RootLabel | undefined;
	for (const root of roots) {
		if (path.startsWith(root.path) && (!best || root.path.length > best.path.length)) best = root;
	}
	return best?.label ?? fallback;
}

export function relativeTime(mtimeMs: number): string {
	const sec = Math.floor((Date.now() - mtimeMs) / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
}

export function basename(cwd: string | undefined): string {
	if (!cwd) return "?";
	const parts = cwd.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || cwd;
}
