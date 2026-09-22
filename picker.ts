/**
 * Session search picker: a free-text fuzzy query over the transcript index,
 * with /resume-like controls. Scope toggles current-cwd vs all (tab), extra
 * index roots on/off, sort by relevance vs recency.
 */

import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { SessionMeta } from "./indexer.ts";
import { basename, groupHits, labelForRoot, relativeTime, stripSnippetMarkers, type RootLabel, type SessionResult } from "./results.ts";
import { search, type SearchIndex } from "./search.ts";

const MAX_VISIBLE = 12;

type Scope = "current" | "all";
type SortMode = "relevance" | "date";

export class SessionSearchPicker implements Component {
	private readonly index: SearchIndex;
	private readonly meta: SessionMeta;
	private readonly roots: RootLabel[];
	private readonly extraRootPaths: string[];
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly kb: KeybindingsManager;
	private readonly currentCwd: string;
	private readonly searchInput = new Input({ prompt: "search: " });
	private readonly onSelect: (sessionPath: string) => void;
	private readonly onJump: (sessionPath: string, entryId: string | undefined) => void;
	private readonly onCancel: () => void;

	private scope: Scope = "all";
	private includeExtraRoots = true;
	private sortMode: SortMode = "relevance";
	private preview = false;
	private list: SelectList;
	private results: SessionResult[] = [];
	private byPath = new Map<string, SessionResult>();

	constructor(options: {
		index: SearchIndex;
		meta: SessionMeta;
		/** All index roots with labels, main root included. */
		roots: RootLabel[];
		/** Paths of the togglable extra roots. */
		extraRootPaths: string[];
		theme: Theme;
		tui: TUI;
		keybindings: KeybindingsManager;
		onSelect: (sessionPath: string) => void;
		onJump: (sessionPath: string, entryId: string | undefined) => void;
		/** Session working directory, for the current-dir scope. */
		currentCwd: string;
		onCancel: () => void;
	}) {
		this.index = options.index;
		this.meta = options.meta;
		this.roots = options.roots;
		this.extraRootPaths = options.extraRootPaths;
		this.currentCwd = options.currentCwd;
		this.theme = options.theme;
		this.tui = options.tui;
		this.kb = options.keybindings;
		this.onSelect = options.onSelect;
		this.onJump = options.onJump;
		this.onCancel = options.onCancel;
		this.list = this.buildList();
	}

	private buildList(): SelectList {
		const query = this.searchInput.getValue();
		const hits = query.trim() ? search(this.index, query, 200) : [];
		this.results = groupHits(hits, this.meta, {
			includeExtraRoots: this.includeExtraRoots,
			extraRoots: this.extraRootPaths,
			currentCwd: this.scope === "current" ? this.currentCwd : undefined,
		});
		if (this.sortMode === "date") {
			this.results.sort((a, b) => b.mtimeMs - a.mtimeMs);
		}
		this.byPath = new Map(this.results.map((r) => [r.path, r]));
		const items: SelectItem[] = this.results.map((r) => ({
			value: r.path,
			label: r.name.length > 70 ? `${r.name.slice(0, 70)}…` : r.name,
			description: `${relativeTime(r.mtimeMs)}  ·  ${labelForRoot(r.path, this.roots)}  ·  ${basename(r.cwd)}  ·  ${truncate(stripSnippetMarkers(r.snippet), 50)}`,
		}));
		const list = new SelectList(items, MAX_VISIBLE, getSelectListTheme());
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private rebuild(): void {
		this.list = this.buildList();
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		this.list.handleInput(delta < 0 ? "\x1b[A" : "\x1b[B");
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "app.session.toggleSort")) {
			this.sortMode = this.sortMode === "relevance" ? "date" : "relevance";
			this.rebuild();
			return;
		}
		if (matchesKey(data, Key.alt("r"))) {
			// alt+r: toggle extra index roots (archives on this machine). ctrl-combos
			// are all taken by pi's global app.* keybindings; alt reaches us because
			// Ghostty is configured with macos-option-as-alt.
			this.includeExtraRoots = !this.includeExtraRoots;
			this.rebuild();
			return;
		}
		if (matchesKey(data, Key.alt("p"))) {
			// alt+p: toggle the preview pane for the selected session
			this.preview = !this.preview;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.alt("j"))) {
			// alt+j: jump to the matched round of the selected session
			const selected = this.list.getSelectedItem();
			const result = selected ? this.byPath.get(selected.value) : undefined;
			if (result) this.onJump(result.path, result.entryId);
			return;
		}
		if (this.kb.matches(data, "tui.input.tab")) {
			this.scope = this.scope === "current" ? "all" : "current";
			this.rebuild();
			return;
		}
		if (this.kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE);
			return;
		}
		if (this.kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE);
			return;
		}
		if (
			this.kb.matches(data, "tui.select.up") ||
			this.kb.matches(data, "tui.select.down") ||
			this.kb.matches(data, "tui.select.confirm") ||
			this.kb.matches(data, "tui.select.cancel")
		) {
			this.list.handleInput(data);
			this.tui.requestRender();
			return;
		}
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== before) this.rebuild();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.list.handleMouse(event);
		if (result?.render) this.tui.requestRender();
		return result;
	}

	invalidate(): void {
		// Nothing is cached outside the child components; they invalidate themselves.
		this.list.invalidate();
		this.searchInput.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const border = (s: string) => this.theme.fg("accent", s);
		lines.push(...new DynamicBorder(border).render(width));
		const scopeLabel = this.scope === "current" ? "current dir" : "all";
		const rootsLabel = this.includeExtraRoots ? "extra roots on" : "extra roots off";
		const sortLabel = this.sortMode === "relevance" ? "relevance" : "date";
		const header = `${this.theme.fg("accent", this.theme.bold("Search sessions"))}  ${this.theme.fg(
			"dim",
			`(${this.results.length} sessions · scope: ${scopeLabel} · ${rootsLabel} · sort: ${sortLabel})`,
		)}`;
		lines.push(...new Text(header, 1, 0).render(width));
		lines.push(...this.searchInput.render(width));
		if (this.results.length === 0) {
			const hint = this.searchInput.getValue().trim() ? "No session matches." : "Type to search session contents.";
			lines.push(...new Text(this.theme.fg("muted", hint), 1, 0).render(width));
		} else {
			lines.push(...this.list.render(width));
		}
		if (this.preview && this.results.length > 0) {
			const selected = this.list.getSelectedItem();
			const result = selected ? this.byPath.get(selected.value) : undefined;
			if (result) {
				lines.push(...new Text(this.theme.fg("accent", `preview · ${result.bestRole} · ${result.name}`), 1, 0).render(width));
				const body = result.fullText.length > 1200 ? `${result.fullText.slice(0, 1200)}…` : result.fullText;
				const chunk = Math.max(20, width - 4);
				let shown = 0;
				for (const raw of body.split("\n")) {
					for (let i = 0; i < raw.length && shown < 16; i += chunk) {
						lines.push(...new Text(this.theme.fg("muted", `  ${raw.slice(i, i + chunk)}`), 1, 0).render(width));
						shown += 1;
					}
					if (shown >= 16) {
						lines.push(...new Text(this.theme.fg("dim", "  …"), 1, 0).render(width));
						break;
					}
				}
			}
		}
		lines.push(
			...new Text(
				this.theme.fg("dim", "type to search · enter resume · alt+j jump · alt+p preview · tab scope · alt+r roots · ctrl+s sort · esc cancel"),
				1,
				0,
			).render(width),
		);
		lines.push(...new DynamicBorder(border).render(width));
		return lines;
	}
}

function truncate(text: string, max: number): string {
	const oneLine = text.replaceAll("\n", " ");
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
