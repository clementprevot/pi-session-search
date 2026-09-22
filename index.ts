/**
 * Search pi sessions by their content: user prompts and final answers, plus
 * compaction and branch summaries. /search opens a fuzzy picker over every
 * session in the live sessions tree plus any configured extra roots (see
 * ~/.pi/agent/extensions/session-search.json), and resumes the one you pick.
 *
 * The index is incremental (byte offsets, append-only docs file) and lives in
 * ~/.pi/agent/session-search/. It refreshes at session start and after every
 * agent turn, so the picker is always current. This extension has no
 * build-time dependency on session-archive; when the picked file happens to
 * sit under sessions-archive, it reuses that extension's restore flow (move
 * back into the live tree, drop the index entry, strip the [ARCHIVE] tag)
 * before switching.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { type Doc, type SessionMeta } from "./indexer.ts";
import { SessionSearchPicker } from "./picker.ts";
import { basename as cwdBasename, groupHits, labelForRoot, relativeTime, stripSnippetMarkers, type SessionResult } from "./results.ts";
import { buildIndex, search, tokenize } from "./search.ts";
import { loadDocs, loadMeta, runScan, storePaths } from "./store.ts";

interface RootConfig {
	path: string;
	label?: string;
}

interface ExtensionConfig {
	extraRoots?: Array<RootConfig | string>;
	/** Index assistant text from tool-call rounds. Default true. */
	indexIntermediate?: boolean;
}

function configPath(): string {
	return join(getAgentDir(), "extensions", "session-search.json");
}

function loadConfig(): RootConfig[] {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as ExtensionConfig;
		return (parsed.extraRoots ?? []).map((root) => (typeof root === "string" ? { path: root } : root));
	} catch {
		return [];
	}
}

/** Default true: assistant text from tool-call rounds is indexed too. */
function indexIntermediate(): boolean {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as ExtensionConfig;
		return parsed.indexIntermediate !== false;
	} catch {
		return true;
	}
}


function sessionsRoot(): string {
	return join(getAgentDir(), "sessions");
}

function archiveRoot(): string {
	return join(getAgentDir(), "sessions-archive");
}

export function cwdDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** First JSONL line holds the session header, including the cwd it was born in. */
export function headerCwd(file: string): string | undefined {
	try {
		const firstLine = readFileSync(file, "utf8").slice(0, 4096).split("\n")[0];
		const header = JSON.parse(firstLine);
		return typeof header?.cwd === "string" ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}

interface ArchiveIndexEntry {
	name?: string;
	cwd?: string;
	archivedAt?: string;
}

function archiveIndexPath(): string {
	return join(archiveRoot(), "index.json");
}

function readArchiveIndex(): Record<string, ArchiveIndexEntry> {
	try {
		return JSON.parse(readFileSync(archiveIndexPath(), "utf8"));
	} catch {
		return {};
	}
}

function writeArchiveIndex(entries: Record<string, ArchiveIndexEntry>): void {
	writeFileSync(archiveIndexPath(), JSON.stringify(entries, null, "\t"));
}

/**
 * Strip the [ARCHIVE] tag from the last session_info name (temp file + rename,
 * crash-safe), so a restored session is not re-archived on its next close.
 */
function stripTagInFile(file: string): void {
	try {
		const tag = "[ARCHIVE] ";
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line.includes('"type":"session_info"')) continue;
			const match = line.match(/"name":"((?:[^"\\]|\\.)*)"/);
			if (!match) return;
			const decoded = JSON.parse(`"${match[1]}"`);
			if (!decoded.startsWith(tag)) return;
			const stripped = JSON.stringify(decoded.slice(tag.length)).slice(1, -1);
			lines[i] = line.replace(`"name":"${match[1]}"`, `"name":"${stripped}"`);
			const tmp = `${file}.session-search-tmp`;
			writeFileSync(tmp, lines.join("\n"));
			renameSync(tmp, file);
			return;
		}
	} catch {
		// best effort: the file is already restored to the live tree
	}
}

/** Move an archived session back into the live tree; returns the new path. */
function restoreFromArchive(archivedFile: string): string | undefined {
	const index = readArchiveIndex();
	const rel = Object.keys(index).find((key) => join(archiveRoot(), key) === archivedFile);
	const cwd = headerCwd(archivedFile) || (rel ? index[rel]?.cwd : undefined);
	if (!cwd) return undefined;
	const targetDir = join(sessionsRoot(), cwdDirName(cwd));
	mkdirSync(targetDir, { recursive: true });
	const target = join(targetDir, basename(archivedFile));
	if (!existsSync(target)) renameSync(archivedFile, target);
	if (rel) {
		const next = readArchiveIndex();
		delete next[rel];
		writeArchiveIndex(next);
	}
	stripTagInFile(target);
	return target;
}

function rootsFor(config: RootConfig[]): string[] {
	const roots = [sessionsRoot(), ...config.map((r) => r.path)];
	return [...new Set(roots)];
}

export default function sessionSearch(pi: ExtensionAPI) {
	let scanTimer: ReturnType<typeof setTimeout> | undefined;
	let lastScanAt = 0;

	async function ensureIndexed(): Promise<void> {
		lastScanAt = Date.now();
		const paths = storePaths(join(getAgentDir(), "session-search"));
		await runScan(paths, rootsFor(loadConfig()), { intermediate: indexIntermediate() });
	}

	function scheduleScan(delayMs: number): void {
		if (scanTimer) clearTimeout(scanTimer);
		scanTimer = setTimeout(() => {
			scanTimer = undefined;
			ensureIndexed().catch(() => {
				// best-effort: the picker rescans on open anyway
			});
		}, delayMs);
	}

	// A turn just finished: the session file gained rounds, index them soon.
	// The 2s guard collapses bursts (agent_end fires once per turn, but a
	// scan may already have just covered it).
	pi.on("agent_end", () => {
		if (Date.now() - lastScanAt < 2_000) return;
		scheduleScan(1_000);
	});

	pi.on("session_start", () => {
		scheduleScan(3_000);
	});

	pi.on("session_shutdown", () => {
		if (scanTimer) {
			clearTimeout(scanTimer);
			scanTimer = undefined;
		}
	});

	interface DeepHit {
		path: string;
		justification: string;
	}

	/** Loose prefilter: union of per-token matches, for the deep-search digest. */
	function deepCandidates(index: ReturnType<typeof buildIndex>, meta: SessionMeta, query: string): SessionResult[] {
		const tokens = tokenize(query);
		const best = new Map<string, { score: number; result: SessionResult }>();
		for (const token of tokens) {
			for (const hit of search(index, token, 60)) {
				const current = best.get(hit.doc.sessionPath);
				if (!current || hit.score > current.score) {
					const [result] = groupHits([hit], meta, { includeExtraRoots: true, extraRoots: [] });
					if (result) best.set(hit.doc.sessionPath, { score: hit.score, result });
				}
			}
		}
		return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 25).map((v) => v.result);
	}

	function buildDigest(candidates: SessionResult[], docs: Doc[]): string {
		const byPath = new Map<string, Doc[]>();
		for (const doc of docs) {
			const list = byPath.get(doc.sessionPath);
			if (list) list.push(doc);
			else byPath.set(doc.sessionPath, [doc]);
		}
		const parts: string[] = [];
		let size = 0;
		for (const candidate of candidates) {
			const sessionDocs = (byPath.get(candidate.path) ?? [])
				.filter((d) => !d.intermediate)
				.slice(0, 5);
			const header = `### ${candidate.name} | ${candidate.path} | ${candidate.cwd ?? "?"}`;
			const body = sessionDocs
				.map((d) => `[${d.role}] ${truncateLine(d.text, 300)}`)
				.join("\n");
			const block = `${header}\n${body}`;
			if (size + block.length > 30_000) break;
			size += block.length;
			parts.push(block);
		}
		return parts.join("\n\n");
	}

	function parseDeepOutput(stdout: string, validPaths: Set<string>): DeepHit[] {
		const hits: DeepHit[] = [];
		for (const line of stdout.split("\n")) {
			const match = line.match(/^SESSION\|(.+?)\|(.+)$/);
			if (!match) continue;
			const path = match[1].trim();
			if (!validPaths.has(path)) continue;
			hits.push({ path, justification: match[2].trim() });
		}
		return hits;
	}

	async function runDeepSearch(query: string): Promise<DeepHit[]> {
		await ensureIndexed();
		const paths = storePaths(join(getAgentDir(), "session-search"));
		const meta: SessionMeta = loadMeta(paths);
		const docs = loadDocs(paths, meta);
		const index = buildIndex(docs);
		const candidates = deepCandidates(index, meta, query);
		if (candidates.length === 0) return [];
		const digest = buildDigest(candidates, docs);
		const prompt = [
			`Rank past work sessions for this topic: "${query}".`,
			"Candidates follow, each with a few excerpts. If the excerpts are not enough, you may inspect the transcript files (plain JSONL; ignore base64 image blobs).",
			"Reply with exactly one line per session, most relevant first, max 5 lines, nothing else:",
			"SESSION|<file path from the candidate header>|<one-line justification>",
			"",
			digest,
		].join("\n");
		const result = await pi.exec("pi", ["-p", "--no-session", prompt], { timeout: 180_000 });
		if (result.code !== 0) {
			throw new Error(`deep search subprocess failed (code ${result.code})`);
		}
		return parseDeepOutput(result.stdout ?? "", new Set(candidates.map((c) => c.path)));
	}

	async function deepSearchCommand(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const query = args.trim();
		if (!query) {
			ctx.ui.notify("Usage: /search --deep <topic>", "info");
			return;
		}
		ctx.ui.notify("Deep search running (headless pi, up to 3 min)...", "info");
		let hits: DeepHit[];
		try {
			hits = await runDeepSearch(query);
		} catch (error) {
			ctx.ui.notify(`Deep search failed: ${error instanceof Error ? error.message : error}`, "warning");
			return;
		}
		if (hits.length === 0) {
			ctx.ui.notify(`Deep search found no session for "${query}"`, "info");
			return;
		}
		const options = hits.map((h) => `${cwdBasename(metaCwd(h.path))}  ·  ${h.justification}`);
		const choice = await ctx.ui.select(`Deep search: ${hits.length} session(s)`, options);
		if (choice === undefined) return;
		const chosen = hits[options.indexOf(choice)];
		await resumeSession(ctx, chosen.path);
	}

	function metaCwd(path: string): string | undefined {
		return loadMeta(storePaths(join(getAgentDir(), "session-search"))).sessions[path]?.cwd;
	}

	async function resumeSession(
		ctx: ExtensionCommandContext,
		sessionPath: string,
	): Promise<void> {
		let target = sessionPath;
		if (sessionPath.startsWith(archiveRoot())) {
			if (!existsSync(sessionPath)) {
				ctx.ui.notify("Archived file no longer on disk", "warning");
				return;
			}
			const restored = restoreFromArchive(sessionPath);
			if (!restored) {
				ctx.ui.notify("Session header unreadable; resume it with: pi --session <file>", "warning");
				return;
			}
			target = restored;
		}
		await ctx.switchSession(target);
	}

	async function jumpToRound(
		ctx: ExtensionCommandContext,
		sessionPath: string,
		entryId: string | undefined,
	): Promise<void> {
		if (!entryId) {
			ctx.ui.notify("No entry position for this match; resuming at the end instead", "info");
			await resumeSession(ctx, sessionPath);
			return;
		}
		// Restore from the archive first if needed, then position the leaf on
		// the matched entry inside the fresh session context.
		let target = sessionPath;
		if (sessionPath.startsWith(archiveRoot())) {
			if (!existsSync(sessionPath)) {
				ctx.ui.notify("Archived file no longer on disk", "warning");
				return;
			}
			const restored = restoreFromArchive(sessionPath);
			if (!restored) {
				ctx.ui.notify("Session header unreadable; resume it with: pi --session <file>", "warning");
				return;
			}
			target = restored;
		}
		await ctx.switchSession(target, {
			withSession: async (sessionCtx) => {
				if (typeof sessionCtx.navigateTree !== "function") {
					ctx.ui.notify("Tree navigation unavailable in this pi version; landed at the end", "info");
					return;
				}
				await sessionCtx.navigateTree(entryId);
				ctx.ui.notify("Jumped to the matched round", "info");
			},
		});
	}

	// Agent-facing retrieval: lets the agent answer "which session did we
	// discuss X in?" in one call instead of grepping raw JSONL (base64 blobs
	// make that useless). The agent cannot switch sessions (pi design), so the
	// tool only reports.
	pi.registerTool({
		name: "search_sessions",
		label: "Search sessions",
		description:
		"Search past pi session contents (user prompts, assistant answers, summaries) across all projects and archives. Use when the user asks to locate a previous session, a past discussion, or what was said about a topic (\"find the session where we discussed X\"). Returns the top matching sessions with snippets.",
		parameters: Type.Object({
			query: Type.String({ description: "Search words (fuzzy, accent-insensitive, all terms must match)" }),
			limit: Type.Optional(Type.Number({ description: "Max sessions to return (default 5, max 20)" })),
		}),
		async execute(_toolCallId, params) {
			await ensureIndexed();
			const paths = storePaths(join(getAgentDir(), "session-search"));
			const meta: SessionMeta = loadMeta(paths);
			const docs = loadDocs(paths, meta);
			if (docs.length === 0) {
				return { content: [{ type: "text", text: "No sessions indexed yet." }], details: {} };
			}
			const index = buildIndex(docs);
			const config = loadConfig();
			const roots = [
				{ path: sessionsRoot(), label: "sessions" },
				...config.filter((r) => r.path !== sessionsRoot()).map((r) => ({ path: r.path, label: r.label ?? cwdBasename(r.path) })),
			];
			const hits = search(index, params.query, 200);
			const results = groupHits(hits, meta, {
				includeExtraRoots: true,
				extraRoots: config.map((r) => r.path),
			}).slice(0, Math.min(params.limit ?? 5, 20));
			if (results.length === 0) {
				return { content: [{ type: "text", text: `No session matches "${params.query}".` }], details: {} };
			}
			const lines = results.map(
				(r) =>
					`${r.name}  ·  ${labelForRoot(r.path, roots)}  ·  ${cwdBasename(r.cwd)}  ·  ${relativeTime(r.mtimeMs)}  ·  ${r.rounds} rounds\n  ${truncateLine(stripSnippetMarkers(r.snippet), 140)}\n  file: ${r.path}${r.entryId ? `  entry: ${r.entryId}` : ""}\n  resume: pi --session ${r.path}`,
			);
			return {
				content: [{ type: "text", text: `${results.length} session(s) matching "${params.query}":\n\n${lines.join("\n\n")}` }],
				details: {},
			};
		},
	});

	pi.registerCommand("search", {
		description: "Search session contents (prompts and answers) across projects and archives",
		handler: async (args, ctx) => {
			if (args.trim().startsWith("--deep")) {
				await deepSearchCommand(args.trim().slice("--deep".length), ctx);
				return;
			}
			try {
				await ensureIndexed();
			} catch (error) {
				ctx.ui.notify(`Index scan failed: ${error instanceof Error ? error.message : error}`, "warning");
				return;
			}
			const paths = storePaths(join(getAgentDir(), "session-search"));
			const meta: SessionMeta = loadMeta(paths);
			const docs = loadDocs(paths, meta);
			if (docs.length === 0) {
				ctx.ui.notify("No sessions indexed yet", "info");
				return;
			}
			const index = buildIndex(docs);
			const config = loadConfig();
			const roots = [
				{ path: sessionsRoot(), label: "sessions" },
				...config.filter((r) => r.path !== sessionsRoot()).map((r) => ({ path: r.path, label: r.label ?? cwdBasename(r.path) })),
			];
			const extraRoots = config.map((r) => r.path);

			let chosen: string | { path: string; entryId?: string } | undefined;
			if (ctx.mode === "tui") {
				type Pick = string | { path: string; entryId?: string };
				chosen = await ctx.ui.custom<Pick | null>((tui, theme, keybindings, done) => {
					return new SessionSearchPicker({
						index,
						meta,
						roots,
						extraRootPaths: extraRoots,
						currentCwd: ctx.cwd,
						theme,
						tui,
						keybindings,
						onSelect: (path) => done(path),
						onJump: (path, entryId) => done({ path, entryId }),
						onCancel: () => done(null),
					});
				}) ?? undefined;
			} else {
				// Non-TUI (rpc/json/print): no custom components. If the command was
				// invoked with a query, take the top session; otherwise offer a flat list.
				const query = args.trim();
				const hits = query ? search(index, query, 50) : [];
				const results = groupHits(hits, meta, { includeExtraRoots: true, extraRoots });
				if (results.length === 0) {
					ctx.ui.notify(query ? `No session matches "${query}"` : "Type a query: /search <words>", "info");
					return;
				}
				const options = results.map(
					(r) => `${r.name}  ·  ${labelForRoot(r.path, roots)}  ·  ${cwdBasename(r.cwd)}  ·  ${relativeTime(r.mtimeMs)}  ·  ${truncateLine(stripSnippetMarkers(r.snippet))}`,
				);
				const choice = await ctx.ui.select("Resume a session", options);
				if (choice === undefined) return;
				chosen = results[options.indexOf(choice)]?.path;
			}
			if (!chosen) return;
			const chosenPath = typeof chosen === "string" ? chosen : chosen.path;
			if (!existsSync(chosenPath)) {
				ctx.ui.notify("Session file no longer on disk", "warning");
				return;
			}
			if (typeof chosen === "string") {
				await resumeSession(ctx, chosenPath);
			} else {
				await jumpToRound(ctx, chosenPath, chosen.entryId);
			}
		},
	});
}

function truncateLine(text: string, max = 80): string {
	const oneLine = text.replaceAll("\n", " ");
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
