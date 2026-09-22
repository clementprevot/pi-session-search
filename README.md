# @clementprevot/pi-session-search

A [Pi](https://pi.dev) extension that gives you fuzzy full-text search over every past pi session: user prompts, assistant answers, compaction and branch summaries, across all your projects. `/search` opens a picker that can resume the session you pick, or jump straight to the matched round inside its branching tree, and the agent gets a `search_sessions` tool so "which session did we discuss X in?" is one call instead of grepping raw JSONL.

## Install

```bash
pi install npm:@clementprevot/pi-session-search
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch or issue a `/reload` command).

## How it works

The extension keeps an incremental index (byte offsets, append-only docs file) in `~/.pi/agent/session-search/`. It scans at session start and after every agent turn, so the picker is always current. Only the useful text of each conversation round is indexed: the user prompt and the final assistant answer, plus compaction and branch summaries. Thinking, tool calls, tool results and image blobs are skipped, which keeps the index tiny next to the raw files.

Matching is fuzzy: per token, an exact match beats a prefix match, then a substring, then a subsequence. Queries are accent-insensitive and all query tokens must match. Results are ranked per session, with the best snippet shown.

In the picker:

- type to search, enter to resume the selected session
- `alt+j` jumps to the matched round inside the session's branching tree
- `alt+p` toggles a preview of the matched text
- `tab` toggles scope between the current directory and all sessions
- `alt+r` toggles extra index roots on or off
- `ctrl+s` toggles between relevance and date sorting

`/search --deep <topic>` re-ranks the top candidates by spawning a headless pi subprocess locally (it can take up to 3 minutes) and lets you pick from its top 5, each with a one-line justification.

When the picked session file lives in the archive (from [@clementprevot/pi-session-archive](https://github.com/clementprevot/pi-session-archive)), it is restored to the live sessions tree first, then resumed.

The agent-facing `search_sessions` tool answers "where did we talk about X?" and returns the top matching sessions with snippets and their file paths; it only reports, it never switches sessions.

## Configuration

Optional file at `~/.pi/agent/extensions/session-search.json`:

```json
{
  "extraRoots": ["/absolute/path", { "path": "/absolute/path", "label": "backups" }],
  "indexIntermediate": true
}
```

- `extraRoots`: more directories of pi session files to index, alongside the live sessions tree. Each entry is an absolute path, or an object with a `path` and a display `label`. [@clementprevot/pi-session-archive](https://github.com/clementprevot/pi-session-archive) path is automatically included.
- `indexIntermediate`: whether assistant text from tool-call rounds is indexed (default `true`).

Omit the file for defaults.

## Privacy

Everything is local. The index and the searches run entirely on your machine; session content never leaves it. The only subprocess is a local headless `pi` run for `--deep`.

One thing to know: the index duplicates session text into `~/.pi/agent/session-search/`, so it is one more local file that holds whatever your sessions contain. It never leaves the machine, but it is a second copy of potentially sensitive conversation content, protected by the same file permissions as the rest of your pi directory.

## Local development

```bash
corepack enable
yarn install
yarn test
yarn typecheck
```

To try the extension in a live session without installing it:

```bash
pi -e /path/to/this/repo
```

## License

[MIT](LICENSE)
