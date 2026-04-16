---
name: forge
description: Generate, compare, and refine visual variations of HTML artifacts with structured browser-based feedback
---

# Forge — Visual Variation Workspace

Forge gives you a browser-based workspace for generating, comparing, and refining HTML artifacts — UI designs, architecture diagrams, dashboards, data visualizations — with structured feedback that streams back in real time. You describe what to build; Claude generates N polished HTML variations; you interact in the browser (like/reject whole variations, drop annotation pins, select specific components); those events stream back to Claude, which incorporates all feedback into the next round. Repeat until satisfied, then say "go with A" or "finalize" and Claude writes the result into your actual project files.

## How it works

- Claude generates N self-contained HTML variations and writes them to the session's content directory
- The Bun workspace server detects new files and hot-reloads the browser
- You interact: like/reject variations, drop annotation pins, select components — all captured as structured events
- Events stream to Claude via the `forge-events` channel in real time
- Claude acknowledges feedback and incorporates it into the next round when you ask to refine
- When done, Claude writes the final result as actual project files matching your stack

---

## Phase 1: Setup (once per session)

Check whether the workspace server is already running by looking for:

```
<baseDir>/.forge/sessions/*/state/server-info.json
```

If `server-info.json` exists and the server process is alive, skip launch and tell the developer the URL from that file.

If not running, determine a session ID (timestamp-based, e.g. `1713200000`) and launch the server:

```bash
bun run server/index.ts --port 4546 --session 1713200000 --base $(pwd) &
```

The server writes `.forge/sessions/<sessionId>/state/server-info.json` with port and URL on startup. Wait briefly, then tell the developer:

> Workspace is running at **http://localhost:4546** — open it in your browser.

Session directory layout:

```
<baseDir>/.forge/sessions/<sessionId>/
  content/          ← HTML variation files you write here
  state/
    events.jsonl    ← all interaction events (source of truth)
    server.pid      ← PID of running server
    server-info.json
  bridge/
    cursor          ← last successfully sent line number
```

---

## Phase 2: Generating Variations

### File naming

Write files to `<baseDir>/.forge/sessions/<sessionId>/content/` using this convention:

```
round-1-a.html
round-1-b.html
round-1-c.html
round-2-a.html   ← second round after refinement
```

Round numbers increment with each generation pass. Letters start from `a`.

### What each variation must be

- A **complete, self-contained HTML document** — `<html>`, `<head>` (with `<style>`), `<body>`, all inline. No external dependencies.
- **Polished and realistic** — use plausible content (real-looking names, numbers, labels), not lorem ipsum.
- **Meaningfully distinct** — each variation should explore a genuinely different approach: different layout, visual hierarchy, interaction pattern, or information density. Not the same design with swapped colors.
- Responsive where appropriate; coherent dark theme recommended (matches the workspace).

### Round event

After writing the variation files, append one line to `<baseDir>/.forge/sessions/<sessionId>/state/events.jsonl`:

```json
{"type":"round","seq":0,"round":1,"variations":["a","b","c"],"prompt":"3 variations of a provider dashboard with dark theme","timestamp":1713200030}
```

- `seq`: always write `0` — the bridge assigns ordering by file position
- `round`: increment with each generation pass
- `variations`: array of letter strings matching the files you wrote
- `timestamp`: `Date.now()` in milliseconds (Unix millis, not seconds)

Then tell the developer:

> Round 1 is ready — 3 variations at **http://localhost:4546**

### View mode guidance

Recommend the right view mode when sharing the URL:

| What you generated | Recommended view |
|--------------------|-----------------|
| Components, widgets, cards, small fragments | **Grid View** — compare side by side |
| Full pages, dashboards, multi-section layouts | **Full View** — scroll each in full fidelity |

---

## Phase 3: Responding to Feedback

Events arrive as formatted messages from the bridge (stdout from the channel). Process them as they come.

### Event formats you'll see

**Variation liked (no reason):**
```
[forge] Variation A liked:
```

**Variation rejected (with reason):**
```
[forge] Variation C rejected:
"Too stripped down — losing important context at a glance"
```

**Annotation pin dropped:**
```
[forge] Annotation on Variation B (pin #2, near .chart-area):
"Needs a time range picker"
```

**Component selection:**
```
[forge] Component on Variation A liked: "Revenue stat card" (.stat-card:nth-child(2))
```

**Heartbeat (ignore):**
```
[forge:heartbeat] uptime=342s events_sent=17
```

### Response rules

| Event type | Action |
|------------|--------|
| **Verdict — liked** | Acknowledge immediately. Note what worked. Suggest next step (refine, or go with it). |
| **Verdict — rejected** (with reason) | Acknowledge immediately. Confirm you understood the reason. Suggest alternatives. |
| **Annotation** (with text) | Acknowledge immediately. Quote the note. Confirm it's queued for the next round. |
| **Component selection** | Accumulate silently. Do NOT reply for each click. Wait for explicit refine request. |
| **Heartbeat** | Ignore completely. No response. |
| **Replayed event** (`"replayed": true`) | Process normally. Do not re-acknowledge events you already confirmed. |

Example acknowledgement for a verdict:

> Got it — you liked Variation A. The sidebar grouping and stat cards landed well. Ready to refine, or want to go with A?

Example acknowledgement for an annotation:

> Noted — pin #2 on Variation B: "Needs a time range picker." I'll add that in the next round.

### Generating a new round

When the developer types "refine", "next round", or clicks the Refine button in the workspace (which sends a message via the channel):

1. Reference the accumulated feedback explicitly:
   > You liked A's layout and the stat card pattern. You noted that B needs a time range picker (pin #2). C was rejected — too sparse. Here's Round 2...

2. Write new variation files (`round-2-a.html`, `round-2-b.html`, etc.) incorporating all feedback.

3. Append a new round event to `events.jsonl` with `"round": 2` (incremented).

4. Tell the developer variations are ready.

Each new round should show clear evolution — address the specific notes, keep what was liked, discard what was rejected.

---

## Phase 4: Resolution

When the developer says "go with A", "finalize B", or "merge the sidebar from A with the content area from B":

1. **Identify the final design** — one variation, or a described composite.

2. **Write it as actual project files** matching the project's stack:
   - React project → write `.tsx` / `.jsx` component file(s)
   - Vue project → write `.vue` single-file component(s)
   - Plain HTML project → write the `.html` file directly
   - Other frameworks → match existing patterns in the codebase

3. **Match existing conventions** — look at the project's component structure, naming, import style, and CSS approach before writing.

4. Confirm what was written and where:
   > Written to `src/components/ProviderDashboard.tsx`. Import it where needed.

The workspace stays open — the developer can start a new `/forge` round immediately.

---

## Context You Have

At every point in the session you have access to:

- **Original prompt** — what the developer asked for
- **Session event stream** — full `events.jsonl` (all rounds, all feedback)
- **Current round number** and which variations are on screen
- **Project codebase** — file tree, existing components, design patterns, stack detection
- **Prior round summaries** — "You liked X from Round 1, improved it in Round 2 with Y"

Use this context to synthesize across rounds:

> You liked the sidebar grouping in Round 1 Variation A and the stat cards from Round 2 Variation B. Want me to combine those into a final version?

---

## Layer 2 Fallback

If the channel bridge is unavailable (older Claude Code version, or the developer's environment doesn't support channels):

- Events still accumulate in `events.jsonl`
- The workspace shows a **"Send to Claude"** button that copies the event summary to clipboard
- The developer pastes it into the terminal

When you receive pasted event data, process it exactly the same as streamed events — same acknowledgements, same response rules. The event format is identical; only the transport differs.

---

## Multiple /forge Sessions

The server stays running across `/forge` invocations in the same conversation. Each new invocation:

- Reuses the running server (check `server-info.json` first, don't relaunch)
- Starts a new round sequence from `round-1-*`
- Preserves all prior rounds' events in `events.jsonl`

If an earlier topic comes up, you can reference its events:
> In your earlier forge session you liked the dark sidebar pattern — want me to carry that into this round?
