# Forge — Visual Variation Workspace for Claude Code

**Date:** 2026-04-15
**Status:** Draft
**Plugin:** `forge`
**Repository:** [forge](https://github.com/mahuebel/forge) (open-source Claude Code plugin)

---

## Purpose

Forge is an open-source Claude Code plugin that lets developers generate, compare, and refine visual variations of any HTML artifact — UI designs, architecture diagrams, flowcharts, data visualizations — with structured, multi-granularity feedback that streams back to Claude in real time.

It implements the three-layer progression described in the project's reference document (`claude_code_three_layers_review.md`):

1. **Layer 1 (Static):** Claude generates polished HTML variations the developer can inspect.
2. **Layer 2 (Interactive):** The variations are displayed in an interactive workspace where the developer can select components, drop annotation pins, and accept/reject variations — all captured as structured events.
3. **Layer 3 (Channels loop):** Browser interactions stream to Claude in real time via a Claude Code channel, enabling Claude to react without the developer switching back to the terminal.

## Target audience

Developers already comfortable with Claude Code and plugins who want a visual feedback loop for iterating on HTML artifacts. The experience prioritizes capability over polish.

## Success criteria

- A developer can invoke `/forge`, describe what they want, and see multiple HTML variations in their browser within one conversation turn.
- They can give feedback at three granularity levels (component, annotation, variation) without leaving the browser.
- That feedback reaches Claude in real time and influences the next round of generation.
- The connection is resilient — the developer always knows the channel state, and events are never lost.

---

## System Architecture

Three components work together:

### 1. The Skill (`/forge`)

The slash command the developer invokes. It:

- Accepts a prompt describing what to generate (e.g., "show me 3 variations of a settings page" or "3 approaches to our microservice topology").
- Launches the Bun workspace server if it isn't already running.
- Generates HTML variations and writes them to the workspace's content directory.
- Opens a Claude Code channel that watches the workspace event stream.
- Reacts to incoming feedback events by refining, regenerating, or branching variations.

### 2. The Workspace Server (Bun)

A local Bun server that serves the visual workspace to the browser. It:

- Serves a single-page app that displays variation panels in two viewing modes (Grid View and Full View).
- Provides interaction tools: click-to-select components, drop annotation pins, select/reject whole variations, leave text notes.
- Captures all interactions as a structured JSON event stream.
- Writes events to a JSONL file that the channel bridge watches.
- Supports hot-reloading — when Claude pushes new variations, the browser updates live via WebSocket without a page refresh.

### 3. The Channel Bridge

Connects the workspace event stream to the running Claude Code session. It:

- Tails the event file for new entries.
- Pushes each event into the Claude Code session via a named channel (`forge-events`).
- Batches rapid-fire events (500ms debounce window) to avoid flooding Claude with individual clicks.
- Manages reconnection, replay, and heartbeat (see Resilience section).

Runs as an async loop within the same Bun server process — no separate process to manage.

### Data flow

```
Dev prompt → Skill → Claude generates HTML variations
                  → Writes to workspace content dir
                  → Workspace server detects new files
                  → Browser renders variation panels

Dev interacts in browser → Click/annotate/select
                        → Workspace captures event → appends to events.jsonl
                        → Channel bridge reads event → pushes to Claude session
                        → Claude processes feedback → generates refined variations
                        → (cycle repeats)
```

The developer can also type in the terminal at any point — terminal messages and browser events both reach Claude and are merged as context.

---

## Workspace UI

The workspace has two viewing modes, switchable via a toggle in the toolbar.

### Design reference mockups

Two HTML mockups define the visual direction for the workspace. These files are the source of truth for colors, spacing, typography, component structure, and interaction affordances. Implementation should match them closely.

- **Grid View:** `docs/superpowers/specs/mockups/forge-grid-view.html`
- **Full View:** `docs/superpowers/specs/mockups/forge-full-view.html`

Open either file directly in a browser to see the rendered mockup.

### Grid View (component-level comparison)

For comparing smaller artifacts side by side — components, cards, form layouts, widgets.

**Structure:**

- **Top bar:** Plugin name ("forge"), the original prompt (truncated), channel status badge (green/yellow/red), round counter.
- **Toolbar:** Mode buttons (Select, Annotate, Compare), like/reject bulk actions, view toggle (Grid / Full).
- **Variation grid:** A responsive CSS grid displaying variation panels. Each panel has:
  - A header with the variation label (e.g., "A — Stacked Form") and like/reject buttons.
  - A content area rendering the generated HTML.
  - Annotation pins and component highlights overlaid on the content.
- **Feedback bar:** Fixed bottom strip showing counts (selected, annotations, rejected) and a "Send to Claude" fallback button (visible only when channel is disconnected).

**Visual states for panels:**

| State | Appearance |
|-------|-----------|
| Default | `#27272a` border |
| Hover | `#3f3f46` border |
| Selected/liked | `#f97316` (orange) border, like button turns green |
| Rejected | `#ef4444` border, 50% opacity, reject button turns red |

### Full View (page-level comparison)

For comparing full-page designs that need the entire viewport width.

**Structure:**

- **Top bar and toolbar:** Same as Grid View.
- **Variation chip bar:** Horizontal row of pill-shaped chips, one per variation. The active chip is highlighted orange. Chips show:
  - Variation label (e.g., "A — Clinical Focus").
  - A green checkmark pseudo-element if liked.
  - Strikethrough + red X pseudo-element if rejected.
  - An orange badge with annotation count (e.g., "2") if annotations exist on that variation.
- **Content area:** Full-width rendering of the active variation, centered with a max-width of 1100px.
- **Notes sidebar:** A 300px fixed panel on the right collecting all annotations and general notes. Each note shows its pin number, which variation it belongs to, and the note text. Rejected variation notes appear struck through. Includes a textarea at the bottom for general notes.
- **Feedback bar:** Same as Grid View, adjusted for the notes sidebar width.

### View mode auto-selection

The skill instructs Claude to choose the default view mode based on what was generated:

- Variations that are partial UI components, widgets, or small layout fragments → default to **Grid View**.
- Variations that are full pages, dashboards, or large-scale layouts → default to **Full View**.

The developer can switch at any time via the toolbar toggle.

### Design tokens

The workspace uses a dark theme consistent across both views. Key tokens from the mockups:

| Token | Value | Usage |
|-------|-------|-------|
| Background (body) | `#0a0a0b` | Page background |
| Background (surface) | `#111113` | Panels, top bar, toolbar, notes sidebar |
| Background (elevated) | `#1c1c1f` | Cards, inputs, toggles, chart areas |
| Background (inset) | `#0f0f11` | Panel headers, chip bar |
| Border (primary) | `#27272a` | Panel borders, dividers |
| Border (subtle) | `#1c1c1f` | Inner dividers |
| Border (hover) | `#3f3f46` | Hover states |
| Accent | `#f97316` | Selection, active states, annotation pins, logo |
| Accent (bg) | `rgba(249,115,22,0.1)` | Active chip background, sidebar active item |
| Text (primary) | `#e4e4e7` | Headings, values, active text |
| Text (secondary) | `#a1a1aa` | Body text, descriptions |
| Text (muted) | `#71717a` | Labels, inactive nav items |
| Text (faint) | `#52525b` | Section labels, table headers |
| Success | `#4ade80` on `#14532d` | Liked states, positive changes |
| Danger | `#f87171` on `#450a0a` | Rejected states, negative changes |
| Warning | `#facc15` | Pending states |
| Font stack | `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif` | All text |

---

## Interaction Model

Three interaction modes, selectable via the toolbar. Each produces structured events appended to `events.jsonl`.

### Mode 1: Select (component-level)

The developer clicks a UI element inside a variation. The workspace identifies the nearest meaningful DOM element using a heuristic:

1. Walk up from the click target until finding an element with a semantic tag (`nav`, `header`, `section`, `article`, `aside`, `main`, `form`, `table`, `ul`, `ol`), a class name, or a `data-*` attribute.
2. Highlight it with a dashed orange border (`2px dashed #f97316`, `border-radius: 4px`, `background: rgba(249,115,22,0.06)`).
3. Show like/reject controls on the highlighted element.
4. Generate a human-readable `label` from the element: use `data-label` if present, then `aria-label`, then the element's text content (truncated to 60 chars), then fall back to the tag name + class.

**Event:**

```json
{
  "type": "select",
  "seq": 1,
  "variation": "a",
  "selector": ".stat-card:nth-child(2)",
  "label": "Unread Messages stat card",
  "action": "like",
  "timestamp": 1713200000
}
```

### Mode 2: Annotate (pin-level)

The developer clicks a spot on a variation, which drops a numbered orange pin. A text input appears for the note. On submit, the pin is fixed in place and the note appears both as a tooltip and in the Notes sidebar (Full View) or as a tooltip (Grid View).

**Event:**

```json
{
  "type": "annotate",
  "seq": 2,
  "variation": "a",
  "pin": 3,
  "position": { "x": 0.45, "y": 0.32 },
  "selector": ".chart-area",
  "text": "This chart needs a time range picker",
  "timestamp": 1713200010
}
```

Positions are percentages (0–1) relative to the variation panel, so they survive viewport resizes.

### Mode 3: Verdict (variation-level)

Like or reject an entire variation via the panel header buttons (Grid View) or the chip bar (Full View). An optional text reason can be attached.

**Event:**

```json
{
  "type": "verdict",
  "seq": 3,
  "variation": "c",
  "action": "reject",
  "reason": "Too stripped down — losing important context at a glance",
  "timestamp": 1713200020
}
```

### Round bookmarks

A `round` event is emitted each time Claude generates a new set of variations:

```json
{
  "type": "round",
  "seq": 4,
  "round": 2,
  "variations": ["a", "b", "c"],
  "prompt": "3 variations of a provider dashboard",
  "timestamp": 1713200030
}
```

This lets Claude reconstruct context — which round the feedback refers to, what was on screen when the developer annotated.

---

## Channel Bridge & Real-time Flow

### Channel mechanics

1. The skill opens a named Claude Code channel (`forge-events`) at session startup.
2. The bridge (running inside the Bun server process) tails `events.jsonl` for new lines.
3. On each new event, the bridge pushes it into the channel.
4. Rapid-fire events are debounced: the bridge waits 500ms for a burst to settle, then sends one batched message containing all events from that burst.

### What Claude sees

Events arrive as formatted messages:

```
[forge] Annotation on Variation A (pin #3, near .chart-area):
"This chart needs a time range picker"
```

```
[forge] Variation C rejected:
"Too stripped down — losing important context at a glance"
```

### Flow control

Not every event needs an immediate Claude response. The skill instructions tell Claude to:

- **React immediately** to verdicts (like/reject) and text annotations — these are intentional signals.
- **Accumulate silently** component selections — wait until the developer pauses or explicitly asks for a new round.
- **Generate a new round** when the developer clicks "Refine" in the workspace or types a prompt in the terminal.

### Layer 2 fallback

If channels aren't available (older Claude Code version, unsupported environment), the skill falls back to turn-based Layer 2 behavior:

- Events still accumulate in `events.jsonl`.
- The workspace shows a "Send to Claude" button in the feedback bar.
- Clicking it copies the accumulated event summary to clipboard.
- The developer pastes it in the terminal.

The architecture supports this gracefully because the event stream is the same — the only difference is the transport.

---

## Resilience

### Heartbeat

The bridge emits a heartbeat event every 15 seconds:

```json
{
  "type": "heartbeat",
  "server_uptime_s": 342,
  "events_sent": 17,
  "timestamp": 1713200045
}
```

Claude's skill instructions tell it to ignore heartbeats silently. But if heartbeats stop arriving, Claude knows the bridge is down.

### Browser health indicator

The workspace UI's "Channel Live" badge in the top bar reflects three states:

| State | Badge | Meaning |
|-------|-------|---------|
| Connected | Green `● Channel Live` | Heartbeat flowing, bridge connected |
| Reconnecting | Yellow `● Reconnecting...` | Missed 2+ heartbeats, bridge retrying |
| Disconnected | Red `● Disconnected — feedback queued` | Bridge is down, events captured locally |

The browser pings the server's `/health` endpoint every 5 seconds to determine state.

**The workspace never stops capturing events.** Even when disconnected, clicks and annotations still append to `events.jsonl`. The bridge doesn't own the event stream — it only reads from it.

### Automatic reconnection

1. If a channel write fails, the bridge retries with exponential backoff (1s, 2s, 4s, max 15s).
2. On reconnection, unsent events are replayed from the bridge's cursor (the last successfully sent line number).
3. Replayed events are tagged `"replayed": true` so Claude can distinguish catch-up from live events.

### Crash recovery

1. The skill detects missing heartbeats and alerts Claude.
2. Claude tells the developer: "Lost connection to the workspace. Restarting..." and relaunches the server.
3. On restart, the server picks up the existing `events.jsonl` — nothing is lost.
4. The bridge replays unsent events from the cursor position.

### Sequence numbers

Every event gets a monotonically increasing `seq` field. This lets both the bridge and Claude detect gaps. If Claude receives seq 40 then 43, it knows two events were missed and can request a replay or alert the developer.

### Manual sync (last resort)

If all else fails, the workspace shows a "Sync to Claude" button (visible only in disconnected state) that dumps the full event stream to clipboard. This is the Layer 2 fallback — degraded but functional.

### Resilience summary

| Layer | Purpose |
|-------|---------|
| `events.jsonl` | Source of truth — always written to, survives crashes |
| Bridge cursor | Tracks last-sent position — enables replay on reconnection |
| Sequence numbers | Detect gaps — Claude or bridge can request missing events |
| Heartbeat (15s) | Detect silent failures — both Claude and browser monitor it |
| Browser health badge | Developer sees connection state immediately |
| Auto-reconnect + replay | Transparent recovery without developer intervention |
| Manual sync button | Last resort fallback to Layer 2 behavior |

---

## Skill Orchestration

### Invocation

```
/forge 3 variations of a settings page with tabs and a dark theme
```

Or without arguments:

```
/forge
```

...and Claude asks what to generate.

### Conversation flow

**Phase 1 — Setup (runs once per session)**

1. Skill checks if the workspace server is already running (looks for a PID file and pings the health endpoint).
2. If not running, launches the Bun server (which includes the bridge).
3. Opens the `forge-events` channel.
4. Tells the developer the URL to open.

**Phase 2 — Generation**

1. Claude analyzes the prompt and the current project context (existing components, design system, tech stack).
2. Generates N HTML variation files and writes them to the workspace content directory.
3. Writes a `round` event to `events.jsonl` to bookmark this generation.
4. The workspace detects the new files via its file watcher and renders them (WebSocket push to browser for hot reload).
5. Claude tells the developer: "N variations are ready — take a look at http://localhost:PORT"

**Phase 3 — Feedback loop (repeats)**

1. The developer interacts in the browser — selecting, annotating, liking/rejecting.
2. Events stream to Claude via the channel (or accumulate for batch send).
3. Claude processes feedback per the flow control rules:
   - Verdicts and annotations → acknowledge, suggest next steps.
   - Component selections → accumulate silently.
4. When the developer asks for refinement (in terminal or via workspace "Refine" button), Claude generates new variations incorporating all accumulated feedback.
5. New round event is bookmarked, new files are written, browser updates.

**Phase 4 — Resolution**

1. The developer signals completion — "go with A" or "merge the sidebar from B with the content area from A."
2. Claude produces the final artifact:
   - For UI work: writes the actual component files into the project.
   - For diagrams/architecture: exports the final version as HTML or a format the developer requests.
3. The workspace stays open for the next `/forge` invocation or the developer closes it.

### Context available to Claude

At every point in the feedback loop, the skill ensures Claude has:

- The original prompt.
- The current round number and which variations are on screen.
- The full event stream from this session (all rounds).
- The project context (file tree, existing components, design patterns from the codebase).

This enables Claude to synthesize across rounds: "You liked the sidebar grouping in Round 1 Variation A and the stat cards from Round 2 Variation B — want me to combine those into a final version?"

### Multiple forge sessions

The developer can run `/forge` multiple times in a conversation. Each invocation starts a new round sequence but reuses the running server. Previous rounds' events are preserved — Claude can reference earlier feedback if relevant.

---

## Plugin Structure

### Directory layout

```
forge/
  .claude-plugin/
    plugin.json              ← plugin manifest
  server/
    index.ts                 ← Bun server entry point (HTTP, WebSocket, file watcher, bridge)
    workspace.html           ← SPA shell (the variation viewer)
    interactions.ts          ← event capture, DOM selection heuristics, pin/highlight rendering
    bridge.ts                ← channel bridge (file tailer → channel writer, cursor, replay)
    health.ts                ← heartbeat emitter, /health endpoint, reconnection loop
    styles.css               ← workspace theme
  skills/
    forge/
      SKILL.md               ← skill definition — full orchestration prompt
  README.md                  ← usage docs
```

### Server architecture

A single `Bun.serve()` process handles everything:

- **HTTP routes:** Serves the SPA, static assets (CSS, JS), and a `/health` endpoint.
- **WebSocket:** Pushes new-variation notifications to the browser for hot reload.
- **File watcher:** Monitors the content directory for new HTML files from Claude.
- **Bridge:** Runs as an async loop within the same process — tails `events.jsonl`, pushes to channel, manages cursor and replay.

One process, one port, simple lifecycle.

### Plugin manifest

```json
{
  "name": "forge",
  "description": "Visual variation workspace — generate, compare, and refine UI designs and architecture diagrams with structured feedback",
  "version": "0.1.0",
  "skills": ["skills/forge"]
}
```

### Dependencies and constraints

- **Runtime:** Bun only. No Node.js, no npm packages beyond what Bun provides natively.
- **Frontend:** Vanilla HTML/CSS/JS. No React, no build step, no bundler for the workspace SPA.
- **Storage:** All state is the `events.jsonl` file and HTML variation files on disk. No database.
- **Security:** Localhost only. No authentication needed — this is a local development tool.
- **External dependencies:** None beyond Bun itself.

### State directory structure

Each forge session creates a state directory:

```
.forge/
  sessions/
    <session-id>/
      content/               ← HTML variation files (written by Claude)
        round-1-a.html
        round-1-b.html
        round-1-c.html
        round-2-a.html
        ...
      state/
        events.jsonl          ← all interaction events (source of truth)
        server.pid            ← PID file for the running server
        server-info.json      ← port, URL, directory paths
      bridge/
        cursor                ← last successfully sent line number
```

---

## Out of scope (v0.1)

These are explicitly excluded from the initial version:

- **Persistence across sessions:** Event history is per-conversation. No cross-session memory of past forge rounds.
- **Collaborative use:** Single developer, single browser tab. No multi-user workspace.
- **Export to Figma/design tools:** The output is HTML files in the project, not design tool formats.
- **Custom themes:** The workspace ships with one dark theme. No theme configuration.
- **Plugin marketplace metadata:** Marketplace listing, install flow, and versioning are separate concerns.
