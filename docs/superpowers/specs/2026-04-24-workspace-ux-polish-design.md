# Forge Workspace UX Polish

Four small, independent workspace improvements bundled into a single spec because they all touch the same two files (`workspace.html`, `interactions.js`) and ship together naturally.

## Goals

1. Remove the vestigial `"default"` tab and auto-open the newest real topic.
2. Add hash-based deep-linking so a workspace URL can be shared (ngrok + paste).
3. Add verdict/accept controls to the full view (grid already has them).
4. Remove the non-functional thumbs-up / thumbs-down toolbar buttons.

No server-side changes. No event-model changes. All scope is client-only UI in `server/public/`.

## Non-goals

- Routing library or SPA framework — hash parsing is ~20 lines of vanilla JS.
- Removing the `"default"` topic from the server registry. Bootstrap and legacy migration in `ensureRegistry()` stay intact; only the UI suppresses it.
- Verdict/accept behavior changes. The full-view strip is a new surface that calls existing `handleVerdict` / `handleAccept` — identical event payloads, status semantics, and lock-out rules.
- Persisting view mode (grid/full) in the URL beyond what the variation-present/absent convention already encodes.

## Section 1 — Tab bar cleanup

### Behavior
- `"default"` topic is never shown in the tab bar. `renderTopicTabs()` filters it out unconditionally.
- On initial page load, if the fallback `state.activeTopic === "default"` and at least one non-default topic exists, set `state.activeTopic` to the topic with the highest `createdAt` before the first render.
- Existing server-switched-topics protection is preserved: once the user has an explicit selection (via tab click or URL hash), a server-side `activeId` change does not pull them away.
- When only `"default"` exists (no real topics ever created), the main content area renders a loading/empty state: `"Waiting for the first /forge invocation…"`. Transitioning out of this state relies on the existing WebSocket reload signal (the server emits a reload when a new topic is created), which triggers `loadState()` and re-evaluates the topic list.

### Files
- `server/public/interactions.js` — `fetchTopics`, `renderTopicTabs`, initial-load logic; new `renderEmptyState()` helper.
- `server/public/workspace.html` — no structural change (empty state renders inside existing `#grid-container` or a sibling).
- `server/public/styles.css` — empty-state visual.

## Section 2 — Hash routing + share button

### URL scheme
- `#/<topicId>` — grid view of that topic.
- `#/<topicId>/<variation>` — full view of that variation (`a`, `b`, …).
- No hash — fall through to Section 1's topic-selection logic.

The URL reflects *what is visible*. Grid view = no variation segment; full view = variation segment present.

### Load flow
1. Parse `location.hash` on boot. Extract `topicId` and optional `variation`.
2. If `topicId` present: set `state.activeTopic` before the first `fetchTopics` / `loadState`.
3. If the hashed topic does not resolve after topics have been fetched: render a "Loading topic `<id>`…" placeholder. Each WS reload re-runs `fetchTopics`, which re-checks. Additionally, piggyback on the existing 5s channel-health poll by also calling `fetchTopics` on each tick while a hashed topic is unresolved. After ~20 seconds (4 ticks) with no resolution, fall back to the Section 1 newest-topic default and render a dismissable banner: "Topic `<id>` not found — showing newest."
4. If `variation` present: set `state.view = "full"` and `state.activeVariation = variation` before the first render. If the variation letter is not found in the loaded variations, switch to grid view silently (keeps `state.view = "grid"`).

### State → URL sync
- One helper `updateHash()` called whenever `activeTopic`, `activeVariation`, or `view` changes. Reads current state, writes the minimal hash form using `history.replaceState` (not push — no history-stack pollution from micro-navigations).
- A `hashchange` listener routes external navigation (paste, link click) through existing `switchTopic` / chip-click / view-toggle code paths. One transition, one code path.

### Share button
- Rendered in `.topbar-right` next to `#round-badge`. Label: 🔗 Share.
- On click: `navigator.clipboard.writeText(location.href)`; swap label to "Copied!" for ~1.5s, then restore.
- Clipboard API requires a secure context (HTTPS or localhost) — ngrok's HTTPS tunnels satisfy this. Fallback for insecure contexts: render a hidden `<input>` with the URL value and call `select() + document.execCommand("copy")` as a best-effort; surface an error toast if both paths fail.
- The button's target URL is always `location.href` — it is never pre-computed — so it always matches whatever the viewer sees.

### Files
- `server/public/interactions.js` — `parseHash`, `updateHash`, `handleHashChange`, share-button handler.
- `server/public/workspace.html` — share button in topbar.
- `server/public/styles.css` — button styles, "Copied!" transient state.

## Section 3 — Full-view verdict/accept action strip

### Markup
New `.full-view-header` row inside `#full-container`, above `#full-content`:

```html
<div class="full-view" id="full-container">
  <div class="full-view-header" id="full-header"></div>
  <div class="full-view-content" id="full-content"></div>
</div>
```

Rendered by a new `renderFullViewHeader()` function called from `renderFullView()` alongside `renderChipBar()` and `renderFullContent()`.

### Structure
- Left: `.full-view-label` — "B — Variation" (uppercased letter of `state.activeVariation`).
- Right: `.full-view-actions` — three buttons: ✓ like, ✗ reject, Accept (or 🔒 when this variation is the accepted one).

### Behavior
- Buttons call the existing `handleVerdict(letter, "like"|"reject")` and `handleAccept(letter)` — same event payloads, same server semantics. No new event types.
- State classes applied to the strip (and to its buttons) mirror the grid panel: `liked`, `rejected`, `accepted`, `dimmed`.
- Hidden when `state.activeVariation` is null (rare transient state — chip-click immediately sets it).
- Switching variations via chip click triggers a header re-render so label and button states update.

### Files
- `server/public/workspace.html` — add `#full-header` inside `#full-container`.
- `server/public/interactions.js` — new `renderFullViewHeader()`; wire into `renderFullView()`.
- `server/public/styles.css` — `.full-view-header`, `.full-view-label`, `.full-view-actions`. Extend existing `.panel-header` rules where possible to keep visual consistency.

## Section 4 — Toolbar cleanup

### Remove
- `#btn-like-all` (👍) and `#btn-reject-all` (👎) buttons in `workspace.html`.
- The `.toolbar-divider` separating them from the Select/Annotate/Area group.

### Verification before deletion
- Grep for `btn-like-all` and `btn-reject-all` across the repo to confirm nothing else references them. Current state: zero handlers wired in `interactions.js`.
- Remove any `#btn-like-all` / `#btn-reject-all` CSS rules from `styles.css`.

### Files
- `server/public/workspace.html` — remove both buttons and their divider.
- `server/public/styles.css` — remove associated selectors if any.

## Architecture notes

### Hash as the single source of navigation truth
The hash encodes "what am I looking at" (topic + maybe variation). All other state — verdicts, annotations, accept — remains in the event stream and `state.*` fields. Opening the same URL twice never mutates state; it just re-renders the same view.

### Separation of concerns
- `parseHash` / `updateHash` / `handleHashChange` form a small URL-sync module; they do not know about events, iframes, or rendering.
- The existing `switchTopic`, chip-click, view-toggle handlers are unchanged internally; the hash layer invokes them as the single transition path.

### Graceful degradation
- Unknown topic in hash → loading state, then banner + fallback. Never a hard error.
- Unknown variation letter → drop to grid view for the topic. Never crashes.
- Clipboard API unavailable → fallback copy path; if that fails, error toast. Share functionality never blocks the app.

## Testing

No existing client-side test harness; verification is manual against a live session.

1. Start server, run `/forge` once. Verify the new tab opens automatically; no `"default"` tab visible.
2. Run `/forge` a second time with a different title. Verify the newest tab is now active; the previous tab remains clickable.
3. Click share button on a grid view. Paste URL in a new tab. Verify it deep-links to the same topic in grid view.
4. Switch to full view, select variation B. Share, paste in new tab. Verify URL includes `/b` and the new tab opens directly to full-view-B.
5. In full view, click ✓ / ✗ / Accept. Toggle back to grid. Verify the same variation reflects the action (status color, accepted lock).
6. Visit `http://localhost:4546/#/nonexistent-topic`. Verify loading state, then fallback banner appears after ~20s.
7. Visit `http://localhost:4546/#/<valid-topic>/z` where `z` does not exist. Verify grid view of the valid topic.
8. Inspect the toolbar. Verify 👍 and 👎 are gone; no console errors; no orphan CSS selectors (visual regression check).
9. Reload the page with `#/<topic>/b` in the URL. Verify the full-view-B is the first thing rendered (no grid flash).

## Out of scope

- Encoding `round` in the URL. Forge always shows the latest round; cross-round linking is not a current user need.
- Persisting grid/full preference separately from the variation-present convention.
- A browser-back-button history of navigations within a session. `history.replaceState` is intentional — one hash at a time.
- Keyboard shortcuts for like/reject/accept in the full view. (Grid has none either; add as a separate spec if desired.)
