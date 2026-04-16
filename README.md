# forge

**A visual workspace for iterating on UI with Claude Code — point, comment, react, and refine in real time instead of describing changes in prose.**

Forge turns the usual Claude loop — *"make it more compact… no, less… actually move the sidebar… wait, I meant the other sidebar…"* — into something direct. Claude generates variations, you open them in a browser, click what you like, drop pins on what needs fixing, reject what doesn't work. Your clicks stream back to Claude, and the next round lands with your feedback already baked in.

---

## Why this exists

Traditional Claude iteration on UI designs looks like this:

```
You:    Can you make 3 variations of a settings page?
Claude: [outputs three HTML files]
You:    I like the second one, but the toggle section is cramped,
        and the first one's sidebar is better. Can you combine them
        and also make the buttons bigger... wait, not those buttons,
        the save/cancel buttons...
Claude: [regenerates, mostly guesses what you meant]
You:    Close, but now the spacing is weird between...
```

It works, but you're constantly translating visual intent into prose. Forge skips the translation:

```
You:    /forge 3 variations of a settings page
Claude: Ready — open http://localhost:4546

[you open the browser, look at three designs side by side]
[you click "Like" on variation A's sidebar]
[you drop a pin on B's toggle section: "too cramped, more spacing"]
[you click "Reject" on variation C]

You:    /forge refine
Claude: You liked A's sidebar and flagged B's toggle spacing.
        Here's Round 2 combining both — open the browser again.
```

The difference: Claude gets structured feedback (selectors, positions, verdicts) instead of imprecise prose. You stay in visual flow.

---

## Quick start

### 1. Install [Bun](https://bun.sh) (if you haven't)

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Add the plugin to Claude Code

```bash
git clone https://github.com/mahuebel/forge.git
claude plugin add ./forge
```

### 3. Use it

In any Claude Code session:

```
/forge 3 variations of a pricing page with monthly/yearly toggle
```

Claude starts the workspace server, writes three HTML files, and tells you the URL. Open it in your browser — the rest is clicking.

That's the whole setup. You never run the Bun server yourself.

---

## What you see in the browser

### Grid View (for comparing components)

Three panels side by side. Each loads a variation in an iframe for full style isolation. Hover to highlight, click the header buttons to like or reject the whole variation.

```
┌──────────────────────────────────────────────────────────────┐
│  ⚒ forge    "3 variations of a pricing page..."  ● Live      │
├──────────────────────────────────────────────────────────────┤
│  Select  Annotate   👍 👎   |   Grid | Full                  │
├──────────────┬──────────────┬──────────────────────────────┤
│ A — Basic    │ B — Featured │ C — Side-by-side              │
│  [ iframe ]  │  [ iframe ]  │  [ iframe ]                   │
│     ✓  ✗    │     ✓  ✗    │     ✓  ✗                       │
└──────────────┴──────────────┴──────────────────────────────┘
│  Selected: 1   Annotations: 0   Rejected: 1      [ Refine ] │
└──────────────────────────────────────────────────────────────┘
```

### Full View (for comparing full pages)

One variation takes the full viewport; a chip bar lets you switch between them; a notes sidebar collects every pin you've dropped.

```
┌──────────────────────────────────────────────────────────────┐
│  ⚒ forge    "Dashboard variations..."    ● Live              │
│  Variations:  [ A — Clinical ✓ ] [ B — Analytics ] [ C ✗ ]   │
├───────────────────────────────────────────────────┬──────────┤
│                                                   │  Notes & │
│              [ active variation iframe ]          │  Pins    │
│                     📌1                           │          │
│                                                   │ Pin #1   │
│                              📌2                  │  A: Fix  │
│                                                   │  spacing │
│                                                   │          │
└───────────────────────────────────────────────────┴──────────┘
```

See [docs/superpowers/specs/mockups/forge-grid-view.html](docs/superpowers/specs/mockups/forge-grid-view.html) and [forge-full-view.html](docs/superpowers/specs/mockups/forge-full-view.html) for the pixel-perfect renders — open them in a browser.

---

## The three interaction modes

Click the toolbar to switch between them. All interactions stream structured events back to Claude.

### Select mode

Click any component inside a variation. Forge walks up the DOM to the nearest meaningful element (semantic tag, class, or data attribute) and sends Claude a CSS selector, a human-readable label, and your like/reject verdict.

> `[forge] Component on Variation A liked: "Revenue stat card" (.stat-card:nth-child(2))`

Use it when you want to call out a specific piece rather than the whole variation.

### Annotate mode

Click anywhere to drop a numbered pin. Type a note. Claude sees the variation, approximate position, and your note.

> `[forge] Annotation on Variation B (pin #2, near .chart-area): "Needs a time range picker"`

In Full View, pins collect in the right-side Notes panel for easy scanning.

### Verdict mode

Like or reject an entire variation via the panel header (Grid View) or chip (Full View). Optionally add a reason.

> `[forge] Variation C rejected: "Too stripped down — losing important context at a glance"`

---

## The feedback loop

1. **Claude generates** N variations into the session's content directory
2. **You interact** in the browser (like/reject, annotate, select)
3. **Events stream** to Claude via a local channel (real-time, debounced)
4. **Claude acknowledges** verdicts and annotations immediately; silently accumulates component selections
5. **You ask to refine** — in the terminal or via the workspace's Refine button — and Claude generates Round 2 incorporating everything
6. **Repeat** until you say "go with A" or "finalize the composite"
7. **Claude writes** the final result as actual project files matching your stack (React, Vue, plain HTML, whatever you're using)

### Never lose feedback

The workspace writes every interaction to `events.jsonl` on disk before anything else happens. If the channel to Claude drops:

- The badge turns yellow (reconnecting), then red (disconnected)
- A **Send to Claude** button appears — one click copies the event summary to your clipboard
- When the channel reconnects, unsent events replay automatically
- Nothing is lost, ever

---

## Troubleshooting

**`bun: command not found` when running `/forge`**
Install Bun: `curl -fsSL https://bun.sh/install | bash`, then try again. Forge uses `Bun.serve` and `Bun.file` which aren't available in Node.js.

**Port 4546 is already in use**
Another forge server (from a different project, maybe) is running there. Either:
- Stop it: `kill $(lsof -t -i:4546)`
- Or let Claude launch on the next free port — it handles this automatically.

**The browser badge shows red "Disconnected"**
The bridge isn't forwarding events. Check that `/tmp/forge-server.log` is being written to. Use the **Send to Claude** button as a fallback — paste the copied summary in your terminal and Claude processes it the same way.

**Variations show blank in the iframe**
Check the content directory: `ls .forge/sessions/*/content/`. If files exist but render blank, they may be malformed HTML. Open one directly in a browser to debug.

**Can I run forge in multiple projects at the same time?**
Yes. Each project gets its own `.forge/sessions/` directory and Claude picks an unused port per project.

---

## Under the hood

Forge is three pieces working together:

| Piece | What it does |
|-------|--------------|
| **The skill** (`skills/forge/SKILL.md`) | Tells Claude how to generate variations, respond to events, and produce final artifacts |
| **The workspace server** (Bun, `server/index.ts`) | Serves the browser SPA, watches the content directory, POSTs events to JSONL |
| **The channel bridge** (`server/bridge.ts`) | Tails `events.jsonl`, formats events, streams them to Claude with debounce, replay, and heartbeat |

The event stream (`events.jsonl`) is the single source of truth. Every click appends one line. Sequence numbers let Claude detect gaps. Heartbeats every 15s catch silent bridge failures. The cursor file enables replay from the last-sent position if the bridge reconnects.

Three-layer progression (after [this workflow pattern](docs/superpowers/specs/claude_code_three_layers_review.md)):

1. **Static** — Claude writes HTML you can look at
2. **Interactive** — the HTML becomes a tool you can manipulate, emitting structured events
3. **Channels loop** — events stream back to Claude live, so use-of-tool becomes the prompt

---

## Session layout

When forge runs, state lives under your current project:

```
<your-project>/.forge/sessions/<sessionId>/
  content/              HTML variation files (round-1-a.html, round-1-b.html, …)
  state/
    events.jsonl        interaction events, one per line (source of truth)
    server.pid          running server's PID
    server-info.json    port, URL, paths
  bridge/
    cursor              last-sent line number (for replay on reconnect)
```

Everything is local. No network calls, no external services. The plugin only needs Bun and a browser.

---

## Development

If you want to hack on forge itself:

```bash
git clone https://github.com/mahuebel/forge.git
cd forge

# Run the test suite
bun test

# Run the server directly (bypassing the plugin setup)
bun run server/index.ts --port 4546 --session dev --base "$(pwd)"
```

### Project structure

```
forge/
  .claude-plugin/plugin.json      plugin manifest
  server/
    index.ts                      Bun server entry (wires everything)
    events.ts                     event types, JSONL utilities
    session.ts                    session directory management, PID file, server info
    routes.ts                     HTTP route handlers (/health, /api/state, /api/events, static)
    watcher.ts                    content directory file watcher
    bridge.ts                     channel bridge (tail events.jsonl, format, debounce)
    health.ts                     heartbeat emitter
    public/                       browser SPA
      workspace.html              shell (top bar, toolbar, grid/full views, feedback bar)
      styles.css                  dark theme
      interactions.js             state mgmt, rendering, interaction handlers, WebSocket, health polling
      iframe-bridge.js            injected into variation iframes for DOM inspection via postMessage
  skills/forge/SKILL.md           the prompt Claude follows when /forge runs
  docs/superpowers/
    specs/2026-04-15-forge-design.md    full design spec
    specs/mockups/                      pixel-perfect HTML mockups of grid and full view
    plans/2026-04-15-forge.md           the implementation plan this was built from
```

### Tests

Server-side modules are covered by `bun test`. The browser-side code (`interactions.js`, `iframe-bridge.js`) is verified end-to-end by running the server and exercising the workspace manually.

```bash
bun test                                # all tests
bun test server/bridge.test.ts          # just the bridge
```

---

## What's next

v0.1 deliberately keeps scope tight. Out of scope for now:

- Persistence across Claude Code sessions (event history is per-conversation)
- Collaborative use (single developer, single browser tab)
- Export to Figma or other design tools (output is HTML → project files)
- Custom themes (ships with one dark theme)
- Plugin marketplace distribution

If you have ideas, open an issue or PR at [github.com/mahuebel/forge](https://github.com/mahuebel/forge).

---

## License

MIT
