/**
 * In-memory full-text search over indexed session documents.
 *
 * Dependency-free on purpose (the extension ships as plain TS loaded by pi's
 * jiti, no node_modules): tokenizer + inverted index + a simple scoring
 * model. Per query token a document token matches as: equal > prefix >
 * substring > fuzzy subsequence. All query tokens must match (AND); score is
 * the sum of the best per-token scores, slightly favoring user prompts over
 * long summaries. Snippets wrap matches in \x01..\x02 markers for the picker
 * to turn into styled text.
 */

import type { Doc } from "./indexer.ts";

const MARK_OPEN = "\x01";
const MARK_CLOSE = "\x02";

export interface IndexedDoc {
	doc: Doc;
	/** Lowercased tokens with occurrence counts. */
	tokens: Map<string, number>;
	length: number;
}

export interface SearchIndex {
	docs: IndexedDoc[];
	/** token -> array of doc positions in docs[]. */
	postings: Map<string, number[]>;
}

export interface SearchHit {
	doc: Doc;
	score: number;
	/** Text with matches wrapped in \x01..\x02 markers. */
	snippet: string;
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // fold accents: casks == càsks
		.split(/[^a-z0-9_]+/)
		.filter((t) => t.length > 0);
}

export function buildIndex(docs: Doc[]): SearchIndex {
	const indexed: IndexedDoc[] = [];
	const postings = new Map<string, number[]>();
	for (const doc of docs) {
		const tokens = new Map<string, number>();
		for (const token of tokenize(doc.text)) {
			tokens.set(token, (tokens.get(token) ?? 0) + 1);
		}
		const position = indexed.length;
		indexed.push({ doc, tokens, length: doc.text.length });
		for (const token of tokens.keys()) {
			const list = postings.get(token);
			if (list) list.push(position);
			else postings.set(token, [position]);
		}
	}
	return { docs: indexed, postings };
}

function isSubsequence(needle: string, haystack: string): boolean {
	let i = 0;
	for (const ch of haystack) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return false;
}

/** Best match score of one query token against one document token set. */
function tokenScore(query: string, tokens: Map<string, number>): number | undefined {
	let best: number | undefined;
	for (const [token, count] of tokens) {
		let score: number;
		if (token === query) score = 1;
		else if (query.length >= 2 && token.startsWith(query)) score = 0.8;
		else if (query.length >= 3 && token.includes(query)) score = 0.7;
		else if (query.length >= 3 && query.length <= token.length && isSubsequence(query, token)) score = 0.4;
		else continue;
		// A term appearing many times in one doc is a stronger signal, with a ceiling.
		const tf = 1 + 0.1 * Math.log2(count);
		const weighted = score * tf;
		if (best === undefined || weighted > best) best = weighted;
	}
	return best;
}

/** Wrap every match window in markers, around the first matching region. */
export function makeSnippet(text: string, queryTokens: string[], radius = 60): string {
	const folded = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	let start = -1;
	let end = -1;
	for (const token of queryTokens) {
		const idx = folded.indexOf(token);
		if (idx !== -1 && (start === -1 || idx < start)) {
			start = idx;
			end = idx + token.length;
		}
	}
	if (start === -1) return text.slice(0, radius * 2) + (text.length > radius * 2 ? "…" : "");
	const from = Math.max(0, start - radius);
	const to = Math.min(text.length, end + radius);
	const prefix = from > 0 ? "…" : "";
	const suffix = to < text.length ? "…" : "";
	const body =
		text.slice(from, start) + MARK_OPEN + text.slice(start, end) + MARK_CLOSE + text.slice(end, to);
	return prefix + body + suffix;
}

export function search(index: SearchIndex, query: string, limit = 30): SearchHit[] {
	if (!index?.postings) return []; // defensive: a wiring bug must not crash pi
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];

	const candidates = new Set<number>();
	const fuzzyOnlyTokens: string[] = [];
	for (const token of queryTokens) {
		const list = index.postings.get(token);
		if (list) {
			for (const position of list) candidates.add(position);
		} else {
			fuzzyOnlyTokens.push(token);
		}
	}
	// Tokens with no exact match may still prefix/subsequence-match indexed tokens.
	if (fuzzyOnlyTokens.length > 0) {
		const expanded = new Set<string>();
		for (const queryToken of fuzzyOnlyTokens) {
			for (const indexedToken of index.postings.keys()) {
				if (
					(queryToken.length >= 2 && indexedToken.startsWith(queryToken)) ||
					(queryToken.length >= 3 && indexedToken.includes(queryToken)) ||
					(queryToken.length >= 3 && indexedToken.length >= queryToken.length && isSubsequence(queryToken, indexedToken))
				) {
					expanded.add(indexedToken);
				}
			}
		}
		for (const token of expanded) {
			for (const position of index.postings.get(token) ?? []) candidates.add(position);
		}
	}

	const hits: SearchHit[] = [];
	for (const position of candidates) {
		const entry = index.docs[position];
		let score = 0;
		let allMatched = true;
		for (const token of queryTokens) {
			const s = tokenScore(token, entry.tokens);
			if (s === undefined) {
				allMatched = false;
				break;
			}
			score += s;
		}
		if (!allMatched) continue;
		// Prompts and answers beat summaries on ties.
		const roleBonus = entry.doc.role === "summary" ? 0.9 : 1;
		score *= roleBonus;
		score /= 1 + entry.length / 20_000; // mild length normalization
		hits.push({ doc: entry.doc, score, snippet: makeSnippet(entry.doc.text, queryTokens) });
	}
	hits.sort((a, b) => b.score - a.score);
	return hits.slice(0, limit);
}
