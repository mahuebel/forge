# forge

A Claude Code plugin for generating, comparing, and refining visual variations of HTML artifacts with structured, multi-granularity feedback.

## What it does

When you're iterating on a UI design, architecture diagram, or any visual artifact with Claude, forge gives you an interactive browser workspace to:

1. **View multiple variations side by side** — Claude generates N variations; forge displays them in a browser.
2. **Give structured feedback** — like/reject whole variations, drop numbered pins with notes, or select specific components to call out.
3. **Stream feedback to Claude in real time** — your interactions flow back to Claude's session via a channel; Claude refines based on what you did, not a prose re-explanation.

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code (with plugin support)

## Installation

Clone and register the plugin with Claude Code:

```bash
git clone https://github.com/mahuebel/forge.git
cd forge
claude plugin add .
```

## Usage

In any Claude Code session:

```
/forge 3 variations of a settings page with tabs and a dark theme
```

Or without an argument — Claude will ask what to generate:

```
/forge
```

Claude will:
1. Start the workspace server (once per session)
2. Generate HTML variation files into the session's content directory
3. Tell you to open `http://localhost:4546`

From there, you interact in the browser. Your feedback streams back to Claude automatically.

## The workspace

### Two viewing modes

- **Grid View** — compare smaller artifacts side by side (components, cards, widgets, form layouts)
- **Full View** — view one full-page variation at a time with a chip bar to switch between them and a notes sidebar showing all annotations

Toggle between them via the buttons in the toolbar.

### Three interaction modes

- **Select** — click a component inside a variation to identify it. Claude gets a CSS selector, a human-readable label, and your like/reject verdict.
- **Annotate** — click a spot on a variation to drop a numbered pin. Type a note. The pin and note stream back to Claude along with the variation and approximate position.
- **Verdict** — like or reject an entire variation via the panel header (Grid View) or chip (Full View). Optionally add a reason.

### Feedback bar

Shows running counts of liked, annotated, and rejected variations. Buttons:

- **Clear All** — reset all verdicts and annotations in the current round
- **Refine** — signal Claude you're ready for a new round
- **Send to Claude** (fallback) — if the channel drops, copies your event summary to the clipboard for you to paste in the terminal

### Channel status

The badge in the top bar shows the connection state:

- `● Channel Live` (green) — events streaming
- `● Reconnecting...` (yellow) — bridge retrying
- `● Disconnected — feedback queued` (red) — events captured locally; "Send to Claude" button appears

Events are always written to disk first, so nothing is lost even if the connection drops.

## Development

### Running the server directly

```bash
bun run server/index.ts --port 4546 --session dev --base "$(pwd)"
```

Arguments:
- `--port` — HTTP port (default 4546)
- `--session` — session identifier (default `forge-<timestamp>`)
- `--base` — base directory for the session state (default current working directory)

The server creates a session directory at `<base>/.forge/sessions/<session>/` containing:
- `content/` — HTML variation files
- `state/events.jsonl` — event stream (source of truth)
- `state/server-info.json` — server URL and paths
- `state/server.pid` — server process ID
- `bridge/cursor` — last-sent line marker for channel replay

### Running tests

```bash
bun test
```

All server-side modules have tests under `server/*.test.ts`. The browser-side code (interactions.js, iframe-bridge.js) is verified manually.

### Project structure

```
forge/
  .claude-plugin/plugin.json    Plugin manifest
  server/
    index.ts                    Bun server entry point (wires HTTP, WS, watcher, bridge, heartbeat)
    events.ts                   Event types, JSONL utilities, sequence counter
    session.ts                  Session directory management, PID file, server info
    routes.ts                   HTTP route handlers
    watcher.ts                  Content directory file watcher
    bridge.ts                   Channel bridge (tail events.jsonl, format, debounce)
    health.ts                   Heartbeat emitter
    public/                     Browser-side SPA (workspace.html, styles.css, interactions.js, iframe-bridge.js)
  skills/forge/SKILL.md         The prompt Claude follows on /forge
```

## How it works

Under the hood, forge is a three-component system:

1. **The skill** — tells Claude how to generate variations, respond to events, and produce final artifacts
2. **The workspace server (Bun)** — serves the browser SPA, watches for new variation files, and bridges events to Claude's session
3. **The channel bridge** — tails the event stream and pushes formatted messages to Claude in real time (with debounce, heartbeat, and automatic replay on reconnect)

The event stream (`events.jsonl`) is the single source of truth. Every browser interaction appends one line. Sequence numbers let Claude detect gaps. Heartbeats detect silent failures. Cursors enable replay.

## License

MIT
