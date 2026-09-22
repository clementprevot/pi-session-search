/**
 * Session transcript indexer for pi sessions.
 *
 * Pure functions only (no pi imports) so it can be tested standalone with
 * tsx. Sessions are JSONL trees (see pi's docs/session-format.md); we extract
 * exactly one thing per conversation round: the user prompt (text blocks) and
 * the final assistant answer (the first assistant message whose stopReason is
 * not "toolUse", text blocks only). Thinking, tool calls, tool results, bash
 * output and image blobs are never touched, which is also what keeps the
 * index tiny next to the raw files (the bulk of raw JSONL is base64).
 *
 * Incremental model: meta.json remembers, per session file, the byte offset
 * parsed so far plus size and mtime. JSONL is append-only, so a changed file
 * is re-read from its offset; only a shrunk file (moved, restored, rewritten)
 * triggers a full re-parse, which emits a {"purge": path} marker into
 * docs.jsonl so loaders drop that path's earlier documents. Deleted files are
 * tombstoned (meta entry removed); the search layer excludes any path that is
 * not in meta, and a lazy compaction rewrites docs.jsonl without the dead
 * weight.
 */

export interface SessionMetaEntry {
	/** Session UUID from the header, when readable. */
	sessionId?: string;
	/** cwd from the session header. */
	cwd?: string;
	/** Latest session_info display name, archive tag stripped. */
	name?: string;
	/** First user prompt text (capped), for picker lines. */
	firstPrompt?: string;
	size: number;
	mtimeMs: number;
	/** Byte offset consumed so far (append-only JSONL). */
	offset: number;
	/** Number of rounds extracted so far (used for doc ids). */
	rounds: number;
}

export interface SessionMeta {
	version: 1;
	sessions: Record<string, SessionMetaEntry>;
	/** Extraction options the index was built with (drives re-index on change). */
	intermediate?: boolean;
}

export interface Doc {
	/** "<sessionId or pathhash>:<ordinal>" is stable within a parse lineage. */
	id: string;
	/** Absolute session file path. */
	sessionPath: string;
	/** Entry timestamp (ISO) or unix ms, as found. */
	ts?: string | number;
	role: "user" | "assistant" | "summary";
	text: string;
	/** True when this text came before the round's final answer (compaction, branch summary, session name). */
	meta?: boolean;
	/** True for assistant text from a message that ended in a tool call. */
	intermediate?: boolean;
	/** JSONL entry id, for navigateTree jumps. */
	entryId?: string;
}

export interface PurgeRecord {
	purge: string;
}

export type DocRecord = Doc | PurgeRecord;

export const DOC_CAP = 30_000;
const PROMPT_CAP = 120;

interface ExtractState {
	docs: Doc[];
	name?: string;
	cwd?: string;
	sessionId?: string;
	rounds: number;
	roundsBeforeOffset: number;
	firstPrompt?: string;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") out += (out ? "\n" : "") + text;
		}
	}
	return out;
}

function cap(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function stripArchiveTag(name: string | undefined): string | undefined {
	if (!name) return name;
	const tag = "[ARCHIVE] ";
	return name.startsWith(tag) ? name.slice(tag.length) : name;
}

/**
 * Extract indexable documents and metadata from raw JSONL lines. Lines are
 * already decoded to strings; partial trailing lines (no newline) must not be
 * passed here; the caller keeps them buffered. state carries the extraction
 * across incremental calls on the same file.
 */
export interface ExtractOptions {
	/** Also index assistant text from messages that ended in a tool call. */
	intermediate?: boolean;
}

export function extractFromLines(
	lines: string[],
	sessionPath: string,
	state: ExtractState,
	options: ExtractOptions = {},
): void {
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // tolerate garbage lines; re-parse from zero is the repair path
		}
		switch (entry.type) {
			case "session": {
				if (typeof entry.cwd === "string") state.cwd = entry.cwd;
				if (typeof entry.id === "string") state.sessionId = entry.id;
				break;
			}
			case "session_info": {
				if (typeof entry.name === "string") state.name = stripArchiveTag(entry.name);
				break;
			}
			case "compaction":
			case "branch_summary": {
				if (typeof entry.summary === "string" && entry.summary.trim()) {
					state.docs.push({
						id: `${sessionPath}:${state.rounds}:s`,
						sessionPath,
						ts: (entry.timestamp as string | undefined) ?? undefined,
						role: "summary",
						text: cap(entry.summary, DOC_CAP),
						meta: true,
						entryId: entry.id as string | undefined,
					});
				}
				break;
			}
			case "message": {
				const message = entry.message as Record<string, unknown> | undefined;
				if (!message) break;
				const role = message.role;
				if (role === "user") {
					const text = cap(textFromContent(message.content), DOC_CAP);
					if (!text.trim()) break;
					state.rounds += 1;
					state.docs.push({
						id: `${sessionPath}:${state.rounds}:q`,
						sessionPath,
						entryId: entry.id as string | undefined,
						ts: (entry.timestamp as string | undefined) ?? undefined,
						role: "user",
						text,
					});
					if (state.firstPrompt === undefined) state.firstPrompt = cap(text, PROMPT_CAP);
					break;
				}
				if (role === "assistant") {
					const stopReason = message.stopReason;
					const intermediate = stopReason === "toolUse";
					if (intermediate && !options.intermediate) break;
					const text = cap(textFromContent(message.content), DOC_CAP);
					if (!text.trim()) break;
					state.docs.push({
						id: `${sessionPath}:${state.rounds}:${intermediate ? "i" : "a"}`,
						sessionPath,
						ts: (entry.timestamp as string | undefined) ?? undefined,
						role: "assistant",
						text,
						intermediate,
						entryId: entry.id as string | undefined,
					});
				}
				break;
			}
			default:
				break;
		}
	}
}

function newState(): ExtractState {
	return { docs: [], rounds: 0, roundsBeforeOffset: 0 };
}

export interface ScanOutcome {
	/** Documents to append to docs.jsonl, in order; purge records included. */
	records: DocRecord[];
	/** Updated meta for the scanned root set. */
	meta: SessionMeta;
	/** Session paths that disappeared from disk (tombstoned, kept out of search). */
	tombstoned: string[];
	/** Session paths that were re-parsed from zero (their old docs are purged). */
	reparsed: string[];
}

interface ScanFileState {
	/** Extraction state that survives across incremental scans (name, rounds, firstPrompt). */
	name?: string;
	cwd?: string;
	sessionId?: string;
	firstPrompt?: string;
	rounds: number;
	roundsBeforeOffset: number;
}

interface MetaV2 extends SessionMeta {
	files: Record<string, ScanFileState>;
}

export function emptyMeta(): SessionMeta {
	return { version: 1, sessions: {}, files: {} } as SessionMeta;
}

function isMetaV2(meta: SessionMeta): meta is MetaV2 {
	return "files" in meta;
}

/**
 * Scan the given root directories (recursively one level, matching pi's
 * per-cwd subdirectory layout) and return what changed. meta should be the
 * previously loaded meta (or emptyMeta()).
 */
export async function scanRoots(
	roots: string[],
	meta: SessionMeta,
	options: ExtractOptions = {},
): Promise<ScanOutcome> {
	const files = new Map<string, { path: string; size: number; mtimeMs: number }>();
	for (const root of roots) {
		await collectSessionFiles(root, files);
	}

	const prevSessions = meta.sessions;
	const prevFiles: Record<string, ScanFileState> = isMetaV2(meta) ? meta.files : {};
	const metaHadIntermediate = meta.intermediate ?? false;
	const effectiveIntermediate = options.intermediate ?? false;
	const reindexAll = effectiveIntermediate !== metaHadIntermediate;
	const nextMeta: MetaV2 = { version: 1, sessions: {}, files: {}, intermediate: effectiveIntermediate };
	const records: DocRecord[] = [];
	const tombstoned: string[] = [];
	const reparsed: string[] = [];

	for (const [path, stat] of files) {
		const prev = prevSessions[path];
		const prevState = prevFiles[path];
		if (!reindexAll && prev && prevState && stat.size >= prev.offset && stat.size === prev.size) {
			nextMeta.sessions[path] = prev;
			nextMeta.files[path] = prevState;
			continue; // unchanged
		}
		const isNew = !prev || !prevState;
		const fromZero = isNew || reindexAll || stat.size < prev.size;
		const startOffset = fromZero ? 0 : prev.offset;
		const state = fromZero
			? newState()
			: {
					docs: [],
					name: prevState.name,
					cwd: prevState.cwd,
					sessionId: prevState.sessionId,
					firstPrompt: prevState.firstPrompt,
					rounds: 0,
					roundsBeforeOffset: prevState.rounds,
				};
		if (fromZero && !isNew) {
			reparsed.push(path);
			records.push({ purge: path });
		}

		const { lines, consumed } = await readLinesFrom(path, startOffset);
		extractFromLines(lines, path, state, options);
		state.rounds += state.roundsBeforeOffset;

		nextMeta.sessions[path] = {
			sessionId: state.sessionId,
			cwd: state.cwd,
			name: state.name,
			firstPrompt: state.firstPrompt,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			offset: startOffset + consumed,
			rounds: state.rounds,
		};
		nextMeta.files[path] = {
			name: state.name,
			cwd: state.cwd,
			sessionId: state.sessionId,
			firstPrompt: state.firstPrompt,
			rounds: state.rounds,
			roundsBeforeOffset: state.rounds,
		};
		records.push(...state.docs);
	}

	for (const path of Object.keys(prevSessions)) {
		if (!files.has(path)) {
			tombstoned.push(path);
			records.push({ purge: path });
		}
	}

	return { records, meta: nextMeta, tombstoned, reparsed };
}

async function collectSessionFiles(root: string, out: Map<string, { path: string; size: number; mtimeMs: number }>) {
	const { readdirSync, statSync } = await import("node:fs");
	const { join } = await import("node:path");
	let entries: string[];
	try {
		entries = readdirSync(root, { withFileTypes: true }).map((e) => (e.isDirectory() ? join(root, e.name) : ""));
	} catch {
		return; // root missing or unreadable
	}
	const dirs = [root, ...entries.filter(Boolean)];
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			// Never index our own state files (tests nest the state dir in a scanned root).
			if (name === "meta.json" || name === "docs.jsonl" || name.endsWith(".tmp")) continue;
			const path = join(dir, name);
			try {
				const stat = statSync(path);
				if (!stat.isFile()) continue;
				out.set(path, { path, size: stat.size, mtimeMs: stat.mtimeMs });
			} catch {
				// vanished mid-scan; next scan will see it either way
			}
		}
	}
}

/**
 * Read JSONL lines starting at a byte offset. Returns complete lines only;
 * a trailing partial line (no newline yet) is held back and NOT counted as
 * consumed, so the next scan re-reads it once it is complete.
 */
async function readLinesFrom(
	path: string,
	offset: number,
): Promise<{ lines: string[]; consumed: number }> {
	const { openSync, readSync, closeSync, fstatSync } = await import("node:fs");
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { lines: [], consumed: 0 };
	}
	try {
		const stat = fstatSync(fd);
		const length = Math.max(0, stat.size - offset);
		if (length === 0) return { lines: [], consumed: 0 };
		const buf = Buffer.alloc(length);
		const read = readSync(fd, buf, 0, length, offset);
		if (read === 0) return { lines: [], consumed: 0 };
		const text = buf.toString("utf8", 0, read);
		const nl = text.lastIndexOf("\n");
		if (nl === -1) return { lines: [], consumed: 0 }; // no complete line yet
		const complete = text.slice(0, nl);
		const lines = complete.split("\n").filter((l) => l.length > 0);
		// Bytes consumed = everything up to and including the last newline.
		const consumedBytes = Buffer.byteLength(complete, "utf8") + 1;
		return { lines, consumed: consumedBytes };
	} finally {
		closeSync(fd);
	}
}
