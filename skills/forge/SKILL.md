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

The workspace server is launched and managed by the plugin — the developer never runs shell commands themselves. You do it all.

### Step 1: Look for an existing server for this project

Use the Glob tool on pattern `.forge/sessions/*/state/server-info.json` (relative to cwd) to find any existing session info files.

For each match, use the Read tool to get the `port` field, then run:

```bash
curl -sf http://localhost:<port>/health
```

If it succeeds with `"status":"ok"`, check two more fields on the matched `server-info.json`:

1. **Version match** — compare the `/health` response's `version` against the current plugin version (read from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`).
2. **Ownership match** — compare `server-info.json`'s `claudePid` against `$PPID` (this bash shell's parent, which is the Claude Code process running this session). This is how forge avoids cross-session event misdelivery when multiple Claude sessions are open.

Reuse / relaunch decision:

- **Health ok AND version matches AND `claudePid == $PPID`** → reuse this workspace. Use the `url` and `sessionId` from that `server-info.json`. Skip to Step 3.
- **Health ok BUT `claudePid` missing, or set to a different PID** → another Claude session (or a pre-0.3.3 server) owns this workspace. Do **not** kill it — it may be in active use by that other Claude. Launch a fresh workspace for this session instead (Step 2). Multiple workspaces per project is fine; each is namespaced under its own `.forge/sessions/<id>/` directory.
- **Health ok, ownership matches, version differs** (or `/health` has no `version` field — pre-0.3.1 server) → plugin was updated; relaunch:

  ```bash
  # Read the pid from server-info.json, then:
  kill <old-pid>
  # Wait a moment for the port to free, then proceed to Step 2
  ```

  Tell the developer: "Plugin updated — restarting the forge server from version X.Y.Z."

- **Health check fails / no files match** → launch a new server (Step 2).

### Step 2: Launch the server

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/server/index.ts" --port 4546 --session "forge-$(date +%s)" --base "$(pwd)" --claude-pid "$PPID" > /tmp/forge-server.log 2>&1 &
```

**Why it looks this way:**
- `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's installed directory. Do **not** use a relative path like `server/index.ts` — it will fail once the plugin is installed outside the user's cwd.
- `--base "$(pwd)"` keeps session state scoped to the current project at `.forge/sessions/...`.
- `--claude-pid "$PPID"` tags the workspace with the current Claude Code process's PID. The channel MCP server and the UserPromptSubmit hook both read this field to route events only to the Claude session that owns the workspace. **You must pass this — without it, running forge in multiple Claude sessions causes events to be delivered to the wrong session.** `$PPID` inside this bash command is the Claude Code process because Claude runs bash commands as direct children.
- Redirecting to `/tmp/forge-server.log` keeps the log accessible. The bridge writes formatted events to stdout, so `tail -f /tmp/forge-server.log` will show them as they stream. You can also re-read the file if you miss something.
- Default port 4546 — if it's already in use by a different project's server, the launch will fail. In that case, re-run with `--port 4547` (or whichever is free). Loop up to ~4560 before giving up.

After launching, wait ~1 second and verify:

```bash
curl -sf http://localhost:4546/health
```

If this fails (Bun not installed, port conflict, crash), tell the developer:

- `bun: command not found` → "Install [Bun](https://bun.sh) with `curl -fsSL https://bun.sh/install | bash`, then try `/forge` again."
- Port conflict → pick the next port and re-launch.
- Crash (check `/tmp/forge-server.log`) → surface the error message.

Do **not** fall back to `node` — the server uses Bun-specific APIs (`Bun.serve`, `Bun.file`).

### Step 3: Create a topic

Each `/forge` invocation is a **topic** within the session — its own prompt, rounds, variations, and feedback. A single server can host many topics side-by-side, so re-invoking `/forge` in the same Claude session never needs a new server or port.

Create a topic by POSTing to the workspace:

```bash
curl -sf -X POST "$WORKSPACE_URL/api/topics" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Provider dashboard","prompt":"3 variations of a provider dashboard"}'
```

Response (201):

```json
{
  "topic": { "id": "provider-dashboard", "title": "Provider dashboard", "createdAt": 1713200000000 },
  "contentDir": "/abs/path/.forge/sessions/<sessionId>/content/provider-dashboard"
}
```

You get back the `topic.id` (slugified from title if you don't supply one) and the absolute `contentDir` to write variation files into. Remember the `topic.id` — every round/annotate/verdict/select event you emit for this invocation must carry `topic_id`.

If the developer re-invokes `/forge` in this same Claude session, **create a new topic** rather than writing more rounds into the existing one. The workspace auto-shows a tab bar when more than one topic exists; the developer can switch between them.

### Step 4: Announce the workspace

Read `server-info.json` to get the actual `url` (don't hardcode 4546; you may be on a different port):

> Workspace is running at **http://localhost:4546** — open it in your browser.

If you created a new topic in an existing workspace, mention it:

> Added a new topic "Provider dashboard" to your running forge workspace — it's a new tab at the top.

### Session directory layout

State lives under the developer's current project:

```
<pwd>/.forge/sessions/<sessionId>/
  content/
    <topicId>/      ← HTML variation files written here, one dir per topic
      round-1-a.html
  state/
    events.jsonl    ← all interaction events (source of truth); every event tagged with topic_id
    topics.json     ← topic registry: [{id, title, createdAt, prompt?}] + activeId
    server.pid
    server-info.json
  bridge/
    cursor
```

Whenever you need to write a variation, read the `contentDir` returned by `POST /api/topics` (or compute `<sessionRoot>/content/<topicId>/`). Whenever you append a round event, include `"topic_id": "<topicId>"` at the top level of the JSON line.

---

## Phase 2: Generating Variations

Variations generate in parallel via **orchestrator-workers**: you (the parent) synthesize a brief and assign a distinct angle per slot, then dispatch one subagent per variation in a single message. Each worker writes its HTML file and returns a short summary; you then append a single `round` event.

**Why parallel, not serial:**
- Wall-clock scales with `max(t_a, t_b, t_c)` instead of the sum.
- Parent context stays clean — generated HTML never lands in the transcript.
- Workers have independent contexts, so variations don't anchor on each other mid-generation.

### File naming

Write files to the topic's `contentDir` — absolute path returned by `POST /api/topics` — using this convention:

```
round-1-a.html
round-1-b.html
round-1-c.html
round-2-a.html   ← second round after refinement
```

Round numbers increment with each generation pass within a topic; they reset to 1 when you start a new topic. Letters start from `a`.

### What each variation must be

- A **complete, self-contained HTML document** — `<html>`, `<head>` (with `<style>`), `<body>`, all inline. No external dependencies.
- **Polished and realistic** — use plausible content (real-looking names, numbers, labels), not lorem ipsum.
- **Meaningfully distinct** — each variation should explore a genuinely different approach: different layout, visual hierarchy, interaction pattern, or information density. Not the same design with swapped colors.
- Responsive where appropriate; coherent dark theme recommended (matches the workspace).

### Step 1 — Synthesize the brief and assign angles

Before dispatching, decide:

1. **Core brief** — what every variation must satisfy (the developer's prompt + any constraints gathered in chat).
2. **Accumulated feedback** (refine rounds only) — distill prior rounds into: what was liked, what was rejected, open annotations. This goes into every worker prompt so each one addresses the full picture.
3. **Per-slot angle** — for N variations, name N orthogonal directions. Pick angles that are genuinely different axes, not shades of the same approach. Example for a dashboard:
   - `A`: data-dense, power-user oriented
   - `B`: minimalist, single focal task
   - `C`: visual-first, chart-driven

   The workers will be told what the other slots are exploring so they don't converge.

### Step 2 — Dispatch workers in parallel

In a **single assistant message**, issue N `Agent` tool calls with `subagent_type: "forge-variation-worker"`. They run concurrently. The worker agent has the HTML requirements, output rules, and anti-patterns baked into its system prompt — your prompt just needs to supply the per-invocation context.

Worker prompt template (fill in the braces):

```
Variation {LETTER}, round {ROUND}.

Output path (absolute):
  {CONTENT_DIR}/round-{ROUND}-{letter}.html

## Brief
{core brief synthesized from developer prompt + any constraints}

## Your angle
{one sentence describing this slot's distinctive direction}

## Other variations in this round — do NOT duplicate their direction
- A: {angle A}
- B: {angle B}
- C: {angle C}

## Accumulated feedback from prior rounds
{liked / rejected / annotated synthesis — omit this block on round 1}

## Prior-variation excerpt to carry forward
{file contents or relevant slice, if the developer asked for "more like A" — omit otherwise}
```

If the developer asked for "more like A" or otherwise referenced a specific prior variation, read that file yourself and embed the relevant contents in the worker prompt(s) that need it. Do not tell the worker to read it — the file may be overwritten by the time the worker runs.

### Step 3 — Append the round event (orchestrator only)

Wait for all workers to return. Then append **one** line to `<baseDir>/.forge/sessions/<sessionId>/state/events.jsonl`:

```json
{"type":"round","topic_id":"provider-dashboard","seq":0,"round":1,"variations":["a","b","c"],"prompt":"3 variations of a provider dashboard with dark theme","timestamp":1713200030}
```

- `topic_id`: the topic this round belongs to — must match the slug returned by `POST /api/topics`. Without it, events fall back to the currently-active topic which may not be yours.
- `seq`: always write `0` — the bridge assigns ordering by file position
- `round`: increment with each generation pass **within this topic** (rounds are per-topic, not global)
- `variations`: array of letter strings for the files that actually landed (see partial failure below)
- `timestamp`: `Date.now()` in milliseconds (Unix millis, not seconds)

The parent owns this append, not the workers — a single writer avoids races on `events.jsonl`.

### Step 4 — Announce

> Round 1 is ready — 3 variations at **http://localhost:4546**

### Partial failure

If 1 of N workers fails or times out:

1. Re-dispatch just that slot once with the same prompt.
2. If it fails again, ship the round with the slots that did land — the `variations` array in the round event lists only the letters whose files exist. Tell the developer which slot was skipped and why, and offer to retry it as a follow-up.

Do not block the entire round behind a single stuck worker.

### View mode guidance

Recommend the right view mode when sharing the URL:

| What you generated | Recommended view |
|--------------------|-----------------|
| Components, widgets, cards, small fragments | **Grid View** — compare side by side |
| Full pages, dashboards, multi-section layouts | **Full View** — scroll each in full fidelity |

---

## Phase 3: Responding to Feedback

Feedback reaches you through three paths, in decreasing order of immediacy:

1. **Claude Code channel** (primary, real-time) — if the developer launched Claude Code with `--channels plugin:forge@forge-marketplace`, events arrive in your conversation as `<channel source="forge" ...>` tags the moment they happen in the browser. The `session_id`, `variation`, `action`, and `event_type` meta attributes tell you what to do. You can call the `notify-workspace` MCP tool to show a toast in the developer's browser (useful for acknowledging "working on Round 2…" before you've finished writing files).

2. **UserPromptSubmit hook** (fallback, on next message) — if `--channels` isn't in use, the `inject-forge-feedback` hook reads unprocessed events on the developer's next prompt and injects them as `## forge workspace feedback` context. Tracks progress via `.forge/sessions/<id>/bridge/injected-cursor`.

3. **Bridge stdout** (observability) — formatted messages also appear in `/tmp/forge-server.log`. Useful for debugging or catching up after a restart.

The channel and the hook use separate cursors (`channel-cursor` vs `injected-cursor`) so they don't fight each other. In practice, whichever path fires first for a given event wins — the other will see an empty delta next time it runs.

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

**Refine request (from the Refine button):**
```
[forge] Developer requested refinement
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
| **Refine** | Generate the next round of variations incorporating all accumulated feedback. |
| **Accept** | Terminal pick for this topic/round. Move to Phase 4 resolution — write the accepted variation into actual project files matching the stack's conventions. Do NOT regenerate unless the developer explicitly asks. If a later `accept` arrives on the same topic, treat it as "changed their mind" and use the latest variation. |
| **Heartbeat** | Ignore completely. No response. |
| **Replayed event** (`"replayed": true`) | Process normally. Do not re-acknowledge events you already confirmed. |

Example acknowledgement for a verdict:

> Got it — you liked Variation A. The sidebar grouping and stat cards landed well. Ready to refine, or want to go with A?

Example acknowledgement for an annotation:

> Noted — pin #2 on Variation B: "Needs a time range picker." I'll add that in the next round.

### Generating a new round

The developer can trigger a refinement three ways:

- **Type "refine" or "next round"** in their Claude session — the hook injects pending feedback alongside that message
- **Invoke `/forge-refine`** as a slash command — explicitly asks you to process accumulated feedback and generate the next round
- **Click the Refine button** in the workspace — posts a `refine` event. When the developer next sends you any message (even "ok"), the hook injects that refine signal along with all accumulated feedback

When any of these happen:

1. Reference the accumulated feedback explicitly:
   > You liked A's layout and the stat card pattern. You noted that B needs a time range picker (pin #2). C was rejected — too sparse. Here's Round 2...

2. Run the Phase 2 dispatch pattern with the feedback distilled into every worker prompt and the round number incremented. If the developer asked for "more like A", read the prior file and embed the relevant contents in the applicable worker prompts.

3. After all workers return, append the new round event to `events.jsonl` with `"round": 2` (incremented).

4. Tell the developer variations are ready.

Each new round should show clear evolution — address the specific notes, keep what was liked, discard what was rejected.

---

## Phase 4: Resolution

The developer can signal resolution two ways:

- **Click the Accept button** on a variation card in the workspace — emits an `accept` event. This is the unambiguous "this one, ship it" signal. Treat it as terminal: proceed directly to writing the variation into project files.
- **Type a phrase in chat** like "go with A", "finalize B", or "merge the sidebar from A with the content area from B" — useful for composites or natural-language direction.

When either happens:

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

## Multiple /forge Invocations

The server stays running across `/forge` invocations in the same Claude session. Each new invocation becomes its own **topic** in the running workspace:

- Reuse the existing server (check `server-info.json` first — do not relaunch)
- `POST /api/topics` to allocate a new topic, its content directory, and its slug
- Start a new round sequence from `round-1-*` **inside that topic's `contentDir`**
- Stamp every event with the new `topic_id`
- Prior topics' rounds and feedback remain untouched on disk and in the UI — they're just other tabs in the workspace

The workspace shows a tab strip at the top of the page when more than one topic is active. Switching tabs swaps which topic's variations and annotations are visible; events continue to stream for whichever topic is currently active in the browser. When Claude receives a channel event, the `topic_id` meta attribute tells you which topic it belongs to — always write refinements back to that topic's `contentDir`.

When the Claude session ends, the server shuts down automatically — the SessionEnd hook sends SIGTERM to any server tagged with this Claude's PID, and the server itself runs an orphan watchdog that polls its owning Claude pid every 10s as a fallback for crashes or kill -9. You don't need to clean up servers manually.

If an earlier topic comes up, you can reference its events:
> In your earlier forge session you liked the dark sidebar pattern — want me to carry that into this round?
