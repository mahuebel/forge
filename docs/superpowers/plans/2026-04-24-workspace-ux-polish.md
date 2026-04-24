# Workspace UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four client-only UX improvements to the forge workspace: hide the vestigial `default` tab and auto-open newest, hash-based deep-linking with a copy-to-clipboard share button, verdict/accept controls on the full view, and removal of the non-functional thumbs-up/down toolbar buttons.

**Architecture:** All changes are confined to `server/public/` (static HTML, CSS, vanilla JS). No server-side code, no event-model changes, no new dependencies. Hash routing is ~40 lines of vanilla URL parsing wired into existing state-transition handlers; the hash encodes *what is visible* (topic + optional variation) while all feedback state continues to flow through the existing events system.

**Tech Stack:** Static HTML + CSS + vanilla JavaScript (IIFE module at `server/public/interactions.js`). No build step. No client-side test harness exists for this code — verification is manual against a running server (`bun run server` + `/forge` in a Claude Code session).

**Spec:** [docs/superpowers/specs/2026-04-24-workspace-ux-polish-design.md](../specs/2026-04-24-workspace-ux-polish-design.md)

---

## File Structure

Files modified by this plan:
- `server/public/workspace.html` — add share button, `full-view-header` row, remove thumb buttons
- `server/public/interactions.js` — hash routing, tab selection logic, full-view header renderer, empty state, banner
- `server/public/styles.css` — share button, full-view header, empty state, banner, thumb-rule cleanup

No new files. No file splits — all three files stay under ~1500 lines and have clear single responsibilities already (markup, behavior, presentation).

## Task ordering rationale

Tasks are ordered to keep each commit shippable on its own and to put the riskiest change (hash routing) after the simpler self-contained ones:

1. Toolbar thumb removal — smallest blast radius, pure deletion.
2. Tab bar cleanup — self-contained; introduces empty-state pattern used by Task 6.
3. Full-view header — independent; reuses existing verdict/accept handlers.
4. Hash parse/update helpers — pure functions added with no state wiring yet.
5. Wire hash updates into state transitions — turns helpers on.
6. Honor hash on initial load + unresolved-topic banner — completes deep-linking.
7. Share button — ships after hash routing so the URL it copies is meaningful.

---

## Task 1: Remove non-functional thumbs-up/down toolbar buttons

**Files:**
- Modify: `server/public/workspace.html` (lines 32-38)
- Modify: `server/public/styles.css` (search for `#btn-like-all`, `#btn-reject-all`)

- [ ] **Step 1: Verify no references exist anywhere in repo**

Run:
```bash
cd /Users/mahuebel/Node/forge && grep -rn "btn-like-all\|btn-reject-all" server/ channel/ commands/ hooks/ agents/ skills/
```

Expected output: matches **only** in `server/public/workspace.html` (two `id="..."` attributes) and possibly in `server/public/styles.css`. No matches in `interactions.js` (confirmed during spec; re-verify before deletion).

- [ ] **Step 2: Remove the two buttons and their divider from workspace.html**

Open `server/public/workspace.html`. The current block at lines 32-38:

```html
  <div class="toolbar-divider"></div>
  <button class="tool-btn" id="btn-like-all" title="Like all selected">
    <span class="tool-icon">👍</span>
  </button>
  <button class="tool-btn" id="btn-reject-all" title="Reject all selected">
    <span class="tool-icon">👎</span>
  </button>
  <div class="toolbar-divider"></div>
```

Replace with a single divider (keeping the one separating Select/Annotate/Area from the Grid/Full view toggle):

```html
  <div class="toolbar-divider"></div>
```

- [ ] **Step 3: Remove any #btn-like-all / #btn-reject-all CSS selectors from styles.css**

Run:
```bash
grep -n "btn-like-all\|btn-reject-all" server/public/styles.css
```

If matches are found, delete those rule blocks. If no matches, skip.

- [ ] **Step 4: Manual verification**

1. Start the server: `bun run --cwd /Users/mahuebel/Node/forge server/index.ts` (or whatever the existing startup command is — check `package.json` scripts if unsure).
2. Open `http://localhost:4546`.
3. Confirm toolbar shows only: Select, Annotate, Area, (divider), Grid/Full toggle.
4. Open DevTools console — confirm zero errors.
5. Confirm no visual gap or orphaned divider.

- [ ] **Step 5: Commit**

```bash
cd /Users/mahuebel/Node/forge
git add server/public/workspace.html server/public/styles.css
git commit -m "$(cat <<'EOF'
refactor(workspace): remove non-functional thumbs toolbar buttons

The 👍 and 👎 buttons in the toolbar had no click handlers wired in
interactions.js. Remove both buttons and the associated divider.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Hide the "default" tab and auto-open newest topic

**Files:**
- Modify: `server/public/interactions.js` — `renderTopicTabs` (line ~407), `fetchTopics` (line ~80), `loadState` (line ~113)
- Modify: `server/public/workspace.html` — add empty-state container
- Modify: `server/public/styles.css` — add empty-state styles

- [ ] **Step 1: Add an empty-state container to workspace.html**

In `server/public/workspace.html`, add the empty-state div immediately after the opening of `#grid-container`'s sibling, or as a dedicated element. Place it right after the `<div class="grid" id="grid-container"></div>` line:

```html
<div class="grid" id="grid-container"></div>

<div class="workspace-empty" id="workspace-empty" style="display:none">
  <div class="workspace-empty-title">Waiting for the first /forge invocation…</div>
  <div class="workspace-empty-body">Run <code>/forge &lt;your prompt&gt;</code> in this Claude Code session to generate variations.</div>
</div>
```

- [ ] **Step 2: Add empty-state CSS to styles.css**

Append to `server/public/styles.css`:

```css
/* ============================================================
   Empty state — no real topics yet
   ============================================================ */

.workspace-empty {
  max-width: 520px;
  margin: 80px auto;
  padding: 40px 32px;
  text-align: center;
  border: 1px dashed var(--border-primary);
  border-radius: 12px;
  background: var(--bg-surface);
  color: var(--text-muted);
}

.workspace-empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.workspace-empty-body {
  font-size: 13px;
  line-height: 1.5;
}

.workspace-empty-body code {
  background: var(--bg-inset);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: ui-monospace, monospace;
}
```

- [ ] **Step 3: Modify fetchTopics to pick newest non-default on first load**

In `server/public/interactions.js`, find `fetchTopics` (starts around line 80). Replace the whole function with:

```js
  async function fetchTopics() {
    try {
      const res = await fetch("/api/topics");
      if (!res.ok) return;
      const data = await res.json();
      state.topics = data.topics || [];
      // Preserve the client's current selection if it still exists AND
      // the user has made an explicit pick (hasExplicitTopic). Without an
      // explicit pick, auto-select the newest non-default topic so the
      // workspace opens on a real tab instead of the vestigial default.
      const stillPresent = state.topics.some((t) => t.id === state.activeTopic);
      if (stillPresent && state.hasExplicitTopic) return;
      if (stillPresent && state.activeTopic !== "default") return;
      const newest = pickNewestRealTopic(state.topics);
      if (newest) {
        state.activeTopic = newest.id;
      } else if (!stillPresent) {
        state.activeTopic = data.activeId || "default";
      }
    } catch (err) {
      console.error("[forge] fetchTopics error:", err);
    }
  }

  function pickNewestRealTopic(topics) {
    const real = topics.filter((t) => t.id !== "default");
    if (real.length === 0) return null;
    let newest = real[0];
    for (const t of real) {
      if ((t.createdAt || 0) > (newest.createdAt || 0)) newest = t;
    }
    return newest;
  }
```

Also add the `hasExplicitTopic` flag to the `state` object near the top of the file (around line 7):

Find:
```js
    activeTopic: "default",
```

Replace with:
```js
    activeTopic: "default",
    // True once the user (or the URL hash) has explicitly chosen a topic.
    // Auto-selection (pickNewestRealTopic) does not set this flag so the
    // client keeps promoting newer topics to the foreground during the
    // initial bootstrap window. Once explicit, server-switched topics no
    // longer drag the view away.
    hasExplicitTopic: false,
```

And in `switchTopic` (around line 99), set the flag to true at the start:

Find:
```js
  async function switchTopic(topicId) {
    if (!topicId || topicId === state.activeTopic) return;
    state.activeTopic = topicId;
```

Replace with:
```js
  async function switchTopic(topicId) {
    if (!topicId || topicId === state.activeTopic) return;
    state.activeTopic = topicId;
    state.hasExplicitTopic = true;
```

- [ ] **Step 4: Update renderTopicTabs to filter out the default tab**

Find the function at line ~407. Replace:

```js
  function renderTopicTabs() {
    const bar = document.getElementById("topic-tabs");
    if (!bar) return;
    clearChildren(bar);

    // Collapse when only the default topic is in play — no point showing
    // a tab strip with a single item.
    const showTabs =
      state.topics.length > 1 ||
      (state.topics.length === 1 && state.topics[0].id !== "default");
    bar.classList.toggle("single", !showTabs);
    if (!showTabs) return;

    for (const t of state.topics) {
      const btn = document.createElement("button");
      btn.className = "topic-tab";
      if (t.id === state.activeTopic) btn.classList.add("active");
      btn.textContent = t.title || t.id;
      btn.title = t.id;
      btn.addEventListener("click", () => switchTopic(t.id));
      bar.appendChild(btn);
    }
  }
```

With:

```js
  function renderTopicTabs() {
    const bar = document.getElementById("topic-tabs");
    if (!bar) return;
    clearChildren(bar);

    // The bootstrap "default" topic is never shown in the UI. It exists
    // server-side for legacy migration only. Users navigate between real
    // topics created by /forge invocations.
    const visible = state.topics.filter((t) => t.id !== "default");

    // Collapse when fewer than two real topics — nothing to switch to.
    const showTabs = visible.length > 1;
    bar.classList.toggle("single", !showTabs);
    if (!showTabs) return;

    for (const t of visible) {
      const btn = document.createElement("button");
      btn.className = "topic-tab";
      if (t.id === state.activeTopic) btn.classList.add("active");
      btn.textContent = t.title || t.id;
      btn.title = t.id;
      btn.addEventListener("click", () => switchTopic(t.id));
      bar.appendChild(btn);
    }
  }
```

- [ ] **Step 5: Add empty-state toggling to loadState**

Find `loadState` (line ~113). At the top of the function add:

```js
  function updateEmptyState() {
    const empty = document.getElementById("workspace-empty");
    const grid = document.getElementById("grid-container");
    const full = document.getElementById("full-container");
    if (!empty) return;
    const realTopics = state.topics.filter((t) => t.id !== "default");
    const showEmpty = realTopics.length === 0;
    empty.style.display = showEmpty ? "" : "none";
    if (grid) grid.style.display = showEmpty ? "none" : "";
    if (full) full.style.display = showEmpty ? "none" : "";
  }
```

Place this helper function near the other `render*` helpers (right above `renderTopicTabs`).

Then at the end of `loadState`'s try block (right after `updateStats();`) add:

```js
      updateEmptyState();
```

And inside `connectWebSocket`'s reload branch, after `renderTopicTabs();` add:

```js
            renderTopicTabs();
            updateEmptyState();
```

- [ ] **Step 6: Manual verification**

1. Delete any prior session state: `rm -rf /tmp/forge-sessions/*` (or wherever forge stores sessions — check `server/session.ts` if path differs).
2. Start server: `bun run server/index.ts` (or the existing npm script).
3. Open `http://localhost:4546`. Confirm empty state renders ("Waiting for the first /forge invocation…").
4. From a Claude Code session in a separate terminal, run `/forge test one` — write a few HTML variations. Back in the browser, confirm tabs bar is still collapsed (single real topic) and the variations appear in grid. Confirm no "default" label anywhere in the UI.
5. Run `/forge test two` — write variations to a second topic. In the browser, confirm **the newest topic** is now active (state auto-promotes) and the tab bar now shows both tabs.
6. Click the older tab — confirm it switches. Then run `/forge test three` — since you've now clicked explicitly (`hasExplicitTopic = true`), the client should **stay** on the tab you clicked, not jump to the new one.

- [ ] **Step 7: Commit**

```bash
git add server/public/workspace.html server/public/interactions.js server/public/styles.css
git commit -m "$(cat <<'EOF'
feat(workspace): hide default tab and auto-open newest topic

Filter the bootstrap "default" topic out of the tab bar; promote the
newest real topic to active on initial load; render a loading/empty
state when no real topics exist yet. Preserves the
explicit-selection-wins guard so server-side topic switches don't drag
the user out of a tab they've already clicked.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add verdict/accept action strip to the full view

**Files:**
- Modify: `server/public/workspace.html` — add `#full-header` inside `#full-container`
- Modify: `server/public/interactions.js` — new `renderFullViewHeader()`; call from `renderFullView()`
- Modify: `server/public/styles.css` — `.full-view-header`, `.full-view-label`, `.full-view-actions`

- [ ] **Step 1: Add header div to workspace.html**

Find (currently at lines 54-56):
```html
<div class="full-view" id="full-container">
  <div class="full-view-content" id="full-content"></div>
</div>
```

Replace with:
```html
<div class="full-view" id="full-container">
  <div class="full-view-header" id="full-header"></div>
  <div class="full-view-content" id="full-content"></div>
</div>
```

- [ ] **Step 2: Add full-view-header styles to styles.css**

Append after the existing `.full-view-content` block:

```css
.full-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
}

.full-view-header.liked {
  border-color: #166534;
}

.full-view-header.rejected {
  border-color: #7f1d1d;
}

.full-view-header.accepted {
  border-color: #a16207;
}

.full-view-header.dimmed {
  opacity: 0.75;
}

.full-view-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.full-view-actions {
  display: flex;
  gap: 6px;
}

body[data-view="grid"] .full-view-header {
  display: none;
}
```

Note: the full-view-header piggybacks on the existing `.panel-action` button classes, so no per-button styles are needed.

- [ ] **Step 3: Add renderFullViewHeader function**

In `server/public/interactions.js`, find `renderFullView` (line ~401):

```js
  function renderFullView() {
    renderChipBar();
    renderFullContent();
    renderNotesSidebar();
  }
```

Replace with:

```js
  function renderFullView() {
    renderFullViewHeader();
    renderChipBar();
    renderFullContent();
    renderNotesSidebar();
  }

  function renderFullViewHeader() {
    const host = document.getElementById("full-header");
    if (!host) return;
    clearChildren(host);
    host.className = "full-view-header";

    const v = findVariation(state.activeVariation);
    if (!v) {
      host.style.display = "none";
      return;
    }
    host.style.display = "";

    if (v.status === "liked") host.classList.add("liked");
    if (v.status === "rejected") host.classList.add("rejected");
    if (state.accepted) {
      if (state.accepted === v.variation) host.classList.add("accepted");
      else host.classList.add("dimmed");
    }

    const label = document.createElement("div");
    label.className = "full-view-label";
    label.textContent = v.variation.toUpperCase() + " — Variation";
    host.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "full-view-actions";

    const likeBtn = document.createElement("button");
    likeBtn.className = "panel-action";
    if (v.status === "liked") likeBtn.classList.add("liked");
    likeBtn.textContent = "\u2713"; // ✓
    likeBtn.title = "Like this variation";
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleVerdict(v.variation, "like");
    });
    actions.appendChild(likeBtn);

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "panel-action";
    if (v.status === "rejected") rejectBtn.classList.add("rejected");
    rejectBtn.textContent = "\u2717"; // ✗
    rejectBtn.title = "Reject this variation";
    rejectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleVerdict(v.variation, "reject");
    });
    actions.appendChild(rejectBtn);

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "panel-action accept-btn";
    if (state.accepted === v.variation) acceptBtn.classList.add("accepted");
    acceptBtn.title =
      state.accepted === v.variation
        ? "Accepted — click a different variation to change"
        : "Accept this as the final pick";
    acceptBtn.textContent = state.accepted === v.variation ? "\uD83D\uDD12" : "Accept";
    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAccept(v.variation);
    });
    actions.appendChild(acceptBtn);

    host.appendChild(actions);
  }
```

- [ ] **Step 4: Manual verification**

1. Restart the server. Reload browser.
2. Run `/forge …` if no variations exist. Switch to full view via toolbar.
3. Confirm the header strip appears above the iframe with "A — Variation" (or whichever is active) label on the left and ✓, ✗, Accept buttons on the right.
4. Click ✓. Confirm the strip turns green-bordered. Toggle back to grid via toolbar. Confirm the corresponding panel also shows the `liked` status.
5. Return to full view. Click ✗. Confirm strip turns red-bordered and the panel state toggles.
6. Click Accept. Confirm button becomes 🔒 and strip border turns amber. Toggle to grid — confirm panel is accepted, others are dimmed.
7. Click a different variation's chip. Confirm the header strip label and button states update to the new variation (accepted lock stays on original, dimmed on new).
8. Open DevTools — confirm zero console errors.

- [ ] **Step 5: Commit**

```bash
git add server/public/workspace.html server/public/interactions.js server/public/styles.css
git commit -m "$(cat <<'EOF'
feat(workspace): verdict and accept controls in full view

Add a header strip above the full-view iframe with like/reject/accept
buttons mirroring the grid panel's header. Buttons reuse the existing
handleVerdict / handleAccept handlers so event payloads and status
semantics are identical across views.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add hash parse/update pure helpers

**Files:**
- Modify: `server/public/interactions.js` — add helpers near the top of the file (after the Helpers section, before API section)

This task only adds pure functions. No state is mutated; nothing is wired yet. Safe to commit independently.

- [ ] **Step 1: Add parseHash, buildHash, and updateHash helpers**

In `server/public/interactions.js`, find the `// ─── Helpers ───────────────────` section (line ~40). Just above the `// ─── API ───────────────────` marker (line ~62), add:

```js
  // ─── Hash routing ──────────────────────────────────────────────────────────
  //
  // The URL hash is the single source of truth for navigation:
  //   #/<topicId>              → grid view of that topic
  //   #/<topicId>/<variation>  → full view of that variation (a–z)
  //   (empty)                  → auto-select newest real topic
  //
  // All other state (verdicts, annotations, accepted, round) flows through
  // the event stream. Opening the same URL twice never mutates state.

  function parseHash(hash) {
    if (!hash || hash === "#" || hash === "#/") return { topicId: null, variation: null };
    const raw = hash.replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    if (parts.length === 0) return { topicId: null, variation: null };
    const topicId = /^[a-z0-9][a-z0-9-]{0,63}$/.test(parts[0]) ? parts[0] : null;
    let variation = null;
    if (parts.length >= 2 && /^[a-z]$/.test(parts[1])) {
      variation = parts[1];
    }
    return { topicId, variation };
  }

  function buildHash(topicId, variation) {
    if (!topicId) return "";
    if (variation) return "#/" + topicId + "/" + variation;
    return "#/" + topicId;
  }

  // Computes the hash that reflects current state and writes it with
  // replaceState (no history-stack pollution). A suppression flag lets
  // handleHashChange skip the round-trip when it just applied an external
  // change.
  let suppressNextHashChange = false;

  function updateHash() {
    const topicId =
      state.activeTopic && state.activeTopic !== "default"
        ? state.activeTopic
        : null;
    const variation =
      state.view === "full" && state.activeVariation
        ? state.activeVariation
        : null;
    const target = buildHash(topicId, variation);
    const current = location.hash || "";
    if (current === target) return;
    suppressNextHashChange = true;
    const url = location.pathname + location.search + target;
    history.replaceState(null, "", url);
  }
```

- [ ] **Step 2: Syntax check — load the page, confirm no parse errors**

Reload `http://localhost:4546`. Open DevTools console. Expected: no errors. The new code is defined but not called.

- [ ] **Step 3: Spot-check parseHash in the console**

In the browser DevTools console paste:

```js
// These refer to the IIFE-local parseHash, so re-implement inline for a check:
function p(h) { if (!h || h === "#" || h === "#/") return { topicId: null, variation: null }; const raw = h.replace(/^#\/?/, ""); const parts = raw.split("/").filter(Boolean); if (parts.length === 0) return { topicId: null, variation: null }; const topicId = /^[a-z0-9][a-z0-9-]{0,63}$/.test(parts[0]) ? parts[0] : null; let variation = null; if (parts.length >= 2 && /^[a-z]$/.test(parts[1])) variation = parts[1]; return { topicId, variation }; }
console.log(p(""));                          // {topicId:null, variation:null}
console.log(p("#/nav-redesign"));            // {topicId:"nav-redesign", variation:null}
console.log(p("#/nav-redesign/b"));          // {topicId:"nav-redesign", variation:"b"}
console.log(p("#/BadCaps"));                 // {topicId:null, variation:null}
console.log(p("#/ok/Z"));                    // {topicId:"ok", variation:null}
```

All expected values should match.

- [ ] **Step 4: Commit**

```bash
git add server/public/interactions.js
git commit -m "$(cat <<'EOF'
feat(workspace): add hash parse/update helpers (unwired)

Adds parseHash, buildHash, updateHash, and the suppressNextHashChange
flag. Pure additions — no existing behavior is changed. The next commit
wires these into state-transition handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire hash updates into state transitions

**Files:**
- Modify: `server/public/interactions.js` — call `updateHash()` from `switchTopic`, chip click (in `renderChipBar`), view toggle (in `wireToolbar`), and the full-content initial variation set in `loadState`. Add `hashchange` listener.

- [ ] **Step 1: Call updateHash from switchTopic**

Find `switchTopic` (line ~99, modified in Task 2). Current body ends with `await loadState();`. Replace the whole function with:

```js
  async function switchTopic(topicId) {
    if (!topicId || topicId === state.activeTopic) return;
    state.activeTopic = topicId;
    state.hasExplicitTopic = true;
    // Best-effort server-side active-topic update. If the server doesn't
    // know about this topic we just keep the client choice.
    fetch("/api/topics/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: topicId }),
    }).catch(() => { /* ignore */ });
    renderTopicTabs();
    updateHash();
    await loadState();
  }
```

- [ ] **Step 2: Call updateHash when a chip is clicked (active variation changes)**

Find `renderChipBar` (line ~431). In the chip's click handler, replace:

```js
      chip.addEventListener("click", () => {
        state.activeVariation = v.variation;
        renderFullView();
      });
```

With:

```js
      chip.addEventListener("click", () => {
        state.activeVariation = v.variation;
        updateHash();
        renderFullView();
      });
```

- [ ] **Step 3: Call updateHash from the view-toggle handler**

Find `wireToolbar` (line ~1056). In the view-toggle section, replace:

```js
    viewBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-view");
        if (!view) return;
        state.view = view;
        document.body.dataset.view = view;
        viewBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderCurrentView();
      });
    });
```

With:

```js
    viewBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-view");
        if (!view) return;
        state.view = view;
        document.body.dataset.view = view;
        viewBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        updateHash();
        renderCurrentView();
      });
    });
```

- [ ] **Step 4: Call updateHash after loadState's initial activeVariation set**

Find in `loadState` (around line ~213):

```js
      // Set active variation
      if (state.variations.length > 0 && !findVariation(state.activeVariation)) {
        state.activeVariation = state.variations[0].variation;
      }
```

Replace with:

```js
      // Set active variation. If an activeVariation was carried in from
      // the URL hash and still resolves, keep it; otherwise default to
      // the first variation in the current round.
      if (state.variations.length > 0 && !findVariation(state.activeVariation)) {
        state.activeVariation = state.variations[0].variation;
      }
      updateHash();
```

- [ ] **Step 5: Add hashchange listener**

Add a new function `handleHashChange` and wire it from `init()`. In `server/public/interactions.js`, find the `init` function (line ~1284):

```js
  function init() {
    wireToolbar();
    wireFeedbackBar();
    wireGeneralNote();
    loadState();
    connectWebSocket();
    startHealthPolling();
  }
```

Replace with:

```js
  function init() {
    wireToolbar();
    wireFeedbackBar();
    wireGeneralNote();
    window.addEventListener("hashchange", handleHashChange);
    loadState();
    connectWebSocket();
    startHealthPolling();
  }

  async function handleHashChange() {
    if (suppressNextHashChange) {
      suppressNextHashChange = false;
      return;
    }
    const { topicId, variation } = parseHash(location.hash);

    // Apply topic change first so loadState picks up the right variations.
    if (topicId && topicId !== state.activeTopic) {
      state.activeTopic = topicId;
      state.hasExplicitTopic = true;
      renderTopicTabs();
      await loadState();
    }

    // After loadState, the variation letter may or may not exist.
    if (variation) {
      if (findVariation(variation)) {
        state.activeVariation = variation;
        if (state.view !== "full") {
          state.view = "full";
          document.body.dataset.view = "full";
          document.querySelectorAll(".view-toggle-btn[data-view]").forEach((b) => {
            b.classList.toggle("active", b.getAttribute("data-view") === "full");
          });
        }
      } else {
        // Unknown variation letter for this topic → fall back to grid.
        if (state.view !== "grid") {
          state.view = "grid";
          document.body.dataset.view = "grid";
          document.querySelectorAll(".view-toggle-btn[data-view]").forEach((b) => {
            b.classList.toggle("active", b.getAttribute("data-view") === "grid");
          });
        }
      }
    } else {
      // No variation in the new hash → grid view.
      if (state.view !== "grid") {
        state.view = "grid";
        document.body.dataset.view = "grid";
        document.querySelectorAll(".view-toggle-btn[data-view]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-view") === "grid");
        });
      }
    }

    renderCurrentView();
  }
```

- [ ] **Step 6: Manual verification**

1. Restart the server, reload browser.
2. Run `/forge some-topic-a` in Claude Code. Verify the URL in the browser bar updates to `http://localhost:4546/#/some-topic-a` automatically.
3. Click the Grid/Full toggle to Full. Click chip B. Verify URL becomes `#/some-topic-a/b`.
4. Click chip A. URL becomes `#/some-topic-a/a`. Toggle back to Grid. URL drops the variation: `#/some-topic-a`.
5. Manually edit the hash to `#/some-topic-a/c` in the address bar and press Enter. Verify the workspace switches to Full view on variation C without a full reload.
6. Run `/forge some-topic-b` — now two tabs exist. Click between tabs; URL updates accordingly.
7. Edit hash to `#/some-topic-a/b` manually. Confirm topic switches **and** view flips to Full on variation B.
8. Console: zero errors.

- [ ] **Step 7: Commit**

```bash
git add server/public/interactions.js
git commit -m "$(cat <<'EOF'
feat(workspace): sync URL hash with active topic, variation, and view

Wire updateHash() into switchTopic, chip click, view toggle, and
initial activeVariation resolution. Add a hashchange listener that
applies external URL edits (paste, link click) through the existing
state-transition code paths. No history pollution — uses
replaceState throughout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Honor URL hash on initial load + unresolved-topic banner

**Files:**
- Modify: `server/public/interactions.js` — pre-seed state from hash in `init()`; add banner helpers; piggyback on health poll for resolution retries
- Modify: `server/public/workspace.html` — banner container
- Modify: `server/public/styles.css` — banner styles

- [ ] **Step 1: Add banner container to workspace.html**

In `server/public/workspace.html`, immediately after the `</header>` tag, add:

```html
<div class="workspace-banner" id="workspace-banner" style="display:none"></div>
```

- [ ] **Step 2: Add banner styles to styles.css**

Append:

```css
/* ============================================================
   Banner — transient notifications (topic fallback, etc.)
   ============================================================ */

.workspace-banner {
  padding: 10px 16px;
  background: #422006;
  border-bottom: 1px solid #78350f;
  color: #fbbf24;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.workspace-banner-dismiss {
  background: transparent;
  border: 1px solid #78350f;
  color: #fbbf24;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.workspace-banner-dismiss:hover {
  background: rgba(251, 191, 36, 0.1);
}
```

- [ ] **Step 3: Pre-seed state from hash in init()**

In `server/public/interactions.js`, find `init` (modified in Task 5):

```js
  function init() {
    wireToolbar();
    wireFeedbackBar();
    wireGeneralNote();
    window.addEventListener("hashchange", handleHashChange);
    loadState();
    connectWebSocket();
    startHealthPolling();
  }
```

Replace with:

```js
  function init() {
    wireToolbar();
    wireFeedbackBar();
    wireGeneralNote();

    // Honor URL hash on boot. Setting activeTopic here (before loadState)
    // means the first fetch targets the hashed topic, not the default.
    // unresolvedTopicId stays set until fetchTopics confirms the topic
    // exists; see checkPendingHashTopic.
    const parsed = parseHash(location.hash);
    if (parsed.topicId) {
      state.activeTopic = parsed.topicId;
      state.hasExplicitTopic = true;
      state.pendingHashTopic = parsed.topicId;
    }
    if (parsed.variation) {
      state.activeVariation = parsed.variation;
      state.view = "full";
      document.body.dataset.view = "full";
      document.querySelectorAll(".view-toggle-btn[data-view]").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-view") === "full");
      });
    }

    window.addEventListener("hashchange", handleHashChange);
    loadState();
    connectWebSocket();
    startHealthPolling();
  }
```

Also add `pendingHashTopic` and `pendingHashChecks` to the `state` object (near the top, alongside `hasExplicitTopic`):

```js
    hasExplicitTopic: false,
    // Hash-pointed topic that has not yet appeared in the registry.
    // While set, checkPendingHashTopic will retry on each WS reload and
    // on each health-poll tick. After PENDING_HASH_MAX_CHECKS with no
    // resolution, the banner appears and we fall back to the newest.
    pendingHashTopic: null,
    pendingHashChecks: 0,
```

At the top of the IIFE, below the `state` block, add the constant:

```js
  const PENDING_HASH_MAX_CHECKS = 4; // 4 × 5s health poll = ~20s
```

- [ ] **Step 4: Add banner + pending-topic helpers**

In `server/public/interactions.js`, near the other render helpers (right above `renderTopicTabs`), add:

```js
  function showBanner(message, dismissable) {
    const el = document.getElementById("workspace-banner");
    if (!el) return;
    clearChildren(el);
    const text = document.createElement("span");
    text.textContent = message;
    el.appendChild(text);
    if (dismissable) {
      const btn = document.createElement("button");
      btn.className = "workspace-banner-dismiss";
      btn.textContent = "Dismiss";
      btn.addEventListener("click", () => {
        el.style.display = "none";
      });
      el.appendChild(btn);
    }
    el.style.display = "";
  }

  function hideBanner() {
    const el = document.getElementById("workspace-banner");
    if (el) el.style.display = "none";
  }

  // Called after each fetchTopics to see whether the hash-pointed topic
  // has arrived. Increments a counter; after PENDING_HASH_MAX_CHECKS
  // unsuccessful attempts, falls back to the newest real topic and
  // raises a dismissable banner.
  function checkPendingHashTopic() {
    if (!state.pendingHashTopic) return;
    const found = state.topics.some((t) => t.id === state.pendingHashTopic);
    if (found) {
      state.pendingHashTopic = null;
      state.pendingHashChecks = 0;
      hideBanner();
      return;
    }
    state.pendingHashChecks += 1;
    if (state.pendingHashChecks >= PENDING_HASH_MAX_CHECKS) {
      const missing = state.pendingHashTopic;
      state.pendingHashTopic = null;
      state.pendingHashChecks = 0;
      const newest = pickNewestRealTopic(state.topics);
      if (newest) {
        state.activeTopic = newest.id;
        state.hasExplicitTopic = false; // allow subsequent auto-promote
        updateHash();
        renderTopicTabs();
        loadState();
      }
      showBanner(
        'Topic "' + missing + '" not found — showing newest.',
        true
      );
    } else {
      showBanner(
        'Loading topic "' + state.pendingHashTopic + '"…',
        false
      );
    }
  }
```

- [ ] **Step 5: Wire pendingHashTopic into handleHashChange**

External URL edits (pasting a new hash after initial load) also need to populate `pendingHashTopic` when the topic is unknown — otherwise the banner never appears for that flow.

In `server/public/interactions.js`, find `handleHashChange` (added in Task 5):

```js
    if (topicId && topicId !== state.activeTopic) {
      state.activeTopic = topicId;
      state.hasExplicitTopic = true;
      renderTopicTabs();
      await loadState();
    }
```

Replace with:

```js
    if (topicId && topicId !== state.activeTopic) {
      state.activeTopic = topicId;
      state.hasExplicitTopic = true;
      // If this topic isn't in the known registry yet, mark it pending
      // so fetchTopics' early-return and checkPendingHashTopic's banner
      // kick in (same flow as boot-from-hash).
      const known = state.topics.some((t) => t.id === topicId);
      if (!known) {
        state.pendingHashTopic = topicId;
        state.pendingHashChecks = 0;
      }
      renderTopicTabs();
      await loadState();
    }
```

- [ ] **Step 6: Call checkPendingHashTopic from fetchTopics and health poll**

Find `fetchTopics` (modified in Task 2). After the function sets `state.topics`, add a call. Replace:

```js
  async function fetchTopics() {
    try {
      const res = await fetch("/api/topics");
      if (!res.ok) return;
      const data = await res.json();
      state.topics = data.topics || [];
      // Preserve the client's current selection if it still exists AND
      // the user has made an explicit pick (hasExplicitTopic). Without an
      // explicit pick, auto-select the newest non-default topic so the
      // workspace opens on a real tab instead of the vestigial default.
      const stillPresent = state.topics.some((t) => t.id === state.activeTopic);
      if (stillPresent && state.hasExplicitTopic) return;
      if (stillPresent && state.activeTopic !== "default") return;
      const newest = pickNewestRealTopic(state.topics);
      if (newest) {
        state.activeTopic = newest.id;
      } else if (!stillPresent) {
        state.activeTopic = data.activeId || "default";
      }
    } catch (err) {
      console.error("[forge] fetchTopics error:", err);
    }
  }
```

With:

```js
  async function fetchTopics() {
    try {
      const res = await fetch("/api/topics");
      if (!res.ok) return;
      const data = await res.json();
      state.topics = data.topics || [];
      checkPendingHashTopic();
      // While a hash-pointed topic is still pending, don't overwrite the
      // active selection — we're holding it for the topic to appear.
      if (state.pendingHashTopic) return;
      // Preserve the client's current selection if it still exists AND
      // the user has made an explicit pick (hasExplicitTopic). Without an
      // explicit pick, auto-select the newest non-default topic.
      const stillPresent = state.topics.some((t) => t.id === state.activeTopic);
      if (stillPresent && state.hasExplicitTopic) return;
      if (stillPresent && state.activeTopic !== "default") return;
      const newest = pickNewestRealTopic(state.topics);
      if (newest) {
        state.activeTopic = newest.id;
      } else if (!stillPresent) {
        state.activeTopic = data.activeId || "default";
      }
    } catch (err) {
      console.error("[forge] fetchTopics error:", err);
    }
  }
```

And piggyback on the health poll. Find `startHealthPolling`:

```js
  function startHealthPolling() {
    async function poll() {
      try {
        const res = await fetch("/health");
        setChannelStatus(res.ok ? "live" : "reconnecting");
      } catch {
        setChannelStatus("disconnected");
      }
    }
    setInterval(poll, 5000);
    poll();
  }
```

Replace with:

```js
  function startHealthPolling() {
    async function poll() {
      try {
        const res = await fetch("/health");
        setChannelStatus(res.ok ? "live" : "reconnecting");
      } catch {
        setChannelStatus("disconnected");
      }
      if (state.pendingHashTopic) {
        await fetchTopics();
        renderTopicTabs();
      }
    }
    setInterval(poll, 5000);
    poll();
  }
```

- [ ] **Step 7: Manual verification**

1. Restart server, reload `http://localhost:4546`. Empty state visible (no real topics yet).
2. Visit `http://localhost:4546/#/does-not-exist`. Banner appears: `Loading topic "does-not-exist"…`. Wait ~20 seconds. Banner changes to `Topic "does-not-exist" not found — showing newest.` with a Dismiss button. Since no real topics exist, the workspace stays in the empty state but banner remains.
3. Click Dismiss. Banner disappears.
4. Run `/forge real-one` from Claude Code. Workspace loads real-one.
5. Open a new tab to `http://localhost:4546/#/real-one`. Confirm it opens directly to the real-one topic in grid view (no banner, no flash of empty state beyond the brief initial render).
6. Still in `/forge real-one`, grab a variation letter (e.g., `b`). Open new tab to `http://localhost:4546/#/real-one/b`. Confirm **full view of variation B** is the first render (no grid flash — check by reloading a few times).
7. Visit `http://localhost:4546/#/real-one/z` (letter that does not exist). Confirm grid view of real-one loads; no banner; no error.
8. From the real-one workspace, edit the address bar hash to `#/never-created` and press Enter. Confirm the loading banner appears and the pending-fallback flow works even without a page reload.
9. Run `/forge slow-topic` but immediately after invocation, before the first file is written, visit `http://localhost:4546/#/slow-topic`. Banner appears and should resolve once files land (well under 20s in practice).
10. Console: zero errors.

- [ ] **Step 8: Commit**

```bash
git add server/public/workspace.html server/public/interactions.js server/public/styles.css
git commit -m "$(cat <<'EOF'
feat(workspace): honor URL hash on boot + pending-topic banner

Parse location.hash during init() so the first loadState targets the
deep-linked topic and variation. Render a loading banner while a
hash-pointed topic has not yet appeared in the registry; fall back to
the newest topic and surface a dismissable banner after ~20s
(PENDING_HASH_MAX_CHECKS × 5s health poll).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add the share (copy-link) button

**Files:**
- Modify: `server/public/workspace.html` — share button in topbar-right
- Modify: `server/public/interactions.js` — wire click handler
- Modify: `server/public/styles.css` — share button styles

- [ ] **Step 1: Add share button markup**

In `server/public/workspace.html`, find the topbar-right block (lines 16-19):

```html
  <div class="topbar-right">
    <span class="topbar-badge" id="channel-badge"></span>
    <span class="topbar-badge" id="round-badge">Waiting...</span>
  </div>
```

Replace with:

```html
  <div class="topbar-right">
    <span class="topbar-badge" id="channel-badge"></span>
    <span class="topbar-badge" id="round-badge">Waiting...</span>
    <button class="topbar-share" id="btn-share" title="Copy this view's URL to clipboard">
      <span class="topbar-share-icon">🔗</span>
      <span class="topbar-share-label">Share</span>
    </button>
  </div>
```

- [ ] **Step 2: Add share button styles**

Append to `server/public/styles.css`:

```css
.topbar-share {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  margin-left: 8px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.topbar-share:hover {
  background: var(--bg-elevated);
}

.topbar-share.copied {
  background: var(--success-bg);
  border-color: #166534;
  color: var(--success);
}

.topbar-share-icon {
  font-size: 12px;
}
```

- [ ] **Step 3: Wire the click handler**

In `server/public/interactions.js`, inside `wireToolbar` (the function itself is about mode and view buttons — a share button fits more naturally in its own small wiring function). Add a new function above `wireFeedbackBar`:

```js
  function wireShareButton() {
    const btn = document.getElementById("btn-share");
    if (!btn) return;
    const label = btn.querySelector(".topbar-share-label");
    const originalText = label ? label.textContent : "Share";

    btn.addEventListener("click", async () => {
      const url = location.href;
      let ok = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(url);
          ok = true;
        } else {
          ok = fallbackCopy(url);
        }
      } catch {
        ok = fallbackCopy(url);
      }

      if (ok) {
        btn.classList.add("copied");
        if (label) label.textContent = "Copied!";
        setTimeout(() => {
          btn.classList.remove("copied");
          if (label) label.textContent = originalText;
        }, 1500);
      } else {
        showToast("Copy failed — select the URL from the address bar instead.");
      }
    });
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
```

Then register the wiring in `init`:

```js
  function init() {
    wireToolbar();
    wireFeedbackBar();
    wireGeneralNote();
    wireShareButton();
    // ... rest unchanged
  }
```

- [ ] **Step 4: Manual verification**

1. Restart server, reload browser. Confirm the 🔗 Share button appears in the top-right, after the round badge.
2. Navigate to a real topic (either run `/forge something` or visit `#/<topic>`).
3. Click Share. Confirm the button flashes green and label changes to "Copied!" for ~1.5s.
4. Paste into a new browser tab address bar. Confirm the pasted URL matches the current view (`…#/<topic>` in grid, or `…#/<topic>/<letter>` in full).
5. Switch to Full view, pick a variation. Click Share again. Confirm the copied URL now includes the variation segment.
6. (Optional) Access the workspace via HTTP (not HTTPS, not localhost) to exercise the fallback copy path. If you have ngrok, `ngrok http 4546` and visit the HTTPS tunnel — the modern clipboard API should still work because ngrok's tunnel is a secure context.
7. Console: zero errors.

- [ ] **Step 5: Commit**

```bash
git add server/public/workspace.html server/public/interactions.js server/public/styles.css
git commit -m "$(cat <<'EOF'
feat(workspace): share button copies current view URL

Adds a 🔗 Share button in the topbar-right that copies location.href
(which reflects the current topic + variation via hash routing) to the
clipboard, with a "Copied!" confirmation flash. Falls back to a
textarea+execCommand path in insecure contexts where the Clipboard API
is unavailable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation verification

After Task 7 commits, run the full spec-level test plan to confirm nothing regressed:

- [ ] Start server cleanly. Visit `http://localhost:4546`. Empty state visible.
- [ ] Run `/forge topic-a`. Browser auto-populates URL with `#/topic-a`, switches out of empty state.
- [ ] Run `/forge topic-b`. Newest tab (topic-b) becomes active. URL updates.
- [ ] Click topic-a tab. URL updates. Run `/forge topic-c` — confirm the view **stays on topic-a** (explicit pick).
- [ ] Switch to full view. Pick variation C. Click Share. Paste into new tab. Confirm deep-link works.
- [ ] Click ✓ in full view. Toggle to grid. Confirm status matches.
- [ ] Click Accept in full view. Toggle to grid. Confirm accepted + dimmed states.
- [ ] Visit `#/nonexistent`. Confirm loading banner, then fallback banner after ~20s. Dismiss.
- [ ] Visit `#/topic-a/z`. Confirm grid view of topic-a.
- [ ] Inspect toolbar — 👍 and 👎 gone.
- [ ] Confirm no console errors across all flows.

## Out of scope for this plan

Anything listed under "Out of scope" in the spec ([docs/superpowers/specs/2026-04-24-workspace-ux-polish-design.md](../specs/2026-04-24-workspace-ux-polish-design.md)) — specifically: `round` in the URL, history-stack navigation, keyboard shortcuts for verdict actions, removal of the server-side `default` topic bootstrap.

## Version bump

If this ships as part of a release, bump forge's `plugin.json` and `marketplace.json` patch (or minor, if the share button is considered a new user-facing feature) version in a follow-up commit. Not included as a task because the release cadence is the user's call.
