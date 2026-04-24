// forge workspace interactions — Grid/Full views, modes, iframe bridge
(function () {
  "use strict";

  // ─── State ─────────────────────────────────────────────────────────────────

  const state = {
    view: "grid",           // "grid" | "full"
    mode: "select",         // "select" | "annotate"
    variations: [],         // [{filename, round, variation, status}]
    activeVariation: null,  // letter
    annotations: [],        // [{pin, variation, round, position, selector, text}]
    pinCounter: 0,
    connected: false,
    round: 0,
    prompt: "",
    // Topics layer (0.4.0+): a single server can host many concurrent
    // `/forge` workspaces. Each tab here is a topic; state below
    // (variations, annotations, round, prompt) reflects the active one.
    topics: [],              // [{id, title, createdAt}]
    activeTopic: "default",
    // True once the user (or the URL hash) has explicitly chosen a topic.
    // Auto-selection (pickNewestRealTopic) does not set this flag so the
    // client keeps promoting newer topics to the foreground during the
    // initial bootstrap window. Once explicit, server-switched topics no
    // longer drag the view away.
    hasExplicitTopic: false,
    // Hash-pointed topic that has not yet appeared in the registry.
    // While set, reconcilePendingHashTopic checks on every fetchTopics and
    // tickPendingHashTopic increments the timeout on each health-poll tick.
    // After PENDING_HASH_MAX_CHECKS with no resolution, we fall back to newest.
    pendingHashTopic: null,
    pendingHashChecks: 0,
    // Terminal pick for the current topic+round — null until the user
    // clicks Accept on a variation. Cleared on each new round event.
    // Latest accept wins (last-write) during replay, matching the
    // "overwrite until consumer acks" semantics.
    accepted: null,          // variation letter or null
  };

  const PENDING_HASH_MAX_CHECKS = 4; // 4 × 5s health poll = ~20s

  // Ephemeral state for the annotate flow: between the overlay click and
  // the submit of the input popup, the iframe asynchronously sends back a
  // selector + offset. The message listener patches this object; submit()
  // reads from it when building the final annotation.
  let pendingAnnotateClick = null;
  let annotateClickSeq = 0;

  // Ephemeral state for area-drag annotations. Set on mousedown in area
  // mode, updated on mousemove, consumed on mouseup.
  let areaDrag = null;

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function parseFilename(filename) {
    const match = filename.match(/^round-(\d+)-([a-z])\.html$/);
    if (!match) return null;
    return { round: parseInt(match[1], 10), variation: match[2] };
  }

  function findVariation(letter) {
    return state.variations.find((v) => v.variation === letter) || null;
  }

  function annotationsFor(letter) {
    return state.annotations.filter(
      (a) => a.variation === letter && a.round === state.round
    );
  }

  function clearChildren(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

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

  // ─── API ───────────────────────────────────────────────────────────────────

  async function postEvent(eventData) {
    try {
      const payload = { topic_id: state.activeTopic, ...eventData };
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error("[forge] postEvent failed:", res.status);
      }
    } catch (err) {
      console.error("[forge] postEvent error:", err);
    }
  }

  async function fetchTopics() {
    try {
      const res = await fetch("/api/topics");
      if (!res.ok) return;
      const data = await res.json();
      state.topics = data.topics || [];
      reconcilePendingHashTopic();
      // While a hash-pointed topic is still pending, don't overwrite the
      // active selection — we're holding it for the topic to appear.
      if (state.pendingHashTopic) return;
      // Preserve the client's selection when it still exists. The two
      // guards cover: (1) the user explicitly picked this topic — never
      // swap it out; (2) we already auto-promoted a real topic and it's
      // still here — don't re-promote as new topics arrive, or the view
      // would thrash during bootstrap. Only when neither guard holds do
      // we (re)pick the newest real topic.
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

  async function loadState() {
    try {
      // Refresh topic list on every load — a new `/forge` invocation
      // from Claude creates a topic via HTTP, and we want the tab bar
      // to reflect it without waiting for the WS reload.
      await fetchTopics();
      renderTopicTabs();

      const topic = encodeURIComponent(state.activeTopic);
      const [stateRes, eventsRes] = await Promise.all([
        fetch("/api/state?topic=" + topic),
        fetch("/api/events?topic=" + topic),
      ]);
      const apiState = await stateRes.json();
      const events = await eventsRes.json();

      // Reset state before replay
      state.variations = [];
      state.annotations = [];
      state.pinCounter = 0;
      state.round = apiState.round || 0;

      // Build variations from filenames, filter to the latest round
      const allVariations = (apiState.variations || [])
        .map((filename) => {
          const parsed = parseFilename(filename);
          if (!parsed) return null;
          return {
            filename,
            round: parsed.round,
            variation: parsed.variation,
            status: "default",
          };
        })
        .filter(Boolean);

      if (allVariations.length > 0) {
        const maxRound = allVariations.reduce(
          (acc, v) => Math.max(acc, v.round),
          0
        );
        state.variations = allVariations
          .filter((v) => v.round === maxRound)
          .sort((a, b) => a.variation.localeCompare(b.variation));
      }

      // Replay events to rebuild statuses, annotations, round/prompt.
      //
      // Annotations and verdicts are scoped to the CURRENT round: any
      // feedback from earlier rounds is cleared when a new round event
      // is encountered. Claude still has full history via the channel /
      // hook / events.jsonl, but the workspace UI shouldn't carry stale
      // pins and like/reject marks onto freshly-generated variations —
      // those refer to designs that no longer exist on screen.
      // Round on events is optional for backward compatibility. When
      // absent, treat the event as belonging to the round implied by
      // replay order (state.round at the moment it's encountered). This
      // preserves the old reset-on-round behavior for legacy data while
      // letting new events be scoped by data, not by ordering.
      for (const ev of events) {
        if (ev.type === "round") {
          state.round = ev.round;
          state.prompt = ev.prompt || "";
          state.annotations = [];
          state.pinCounter = 0;
          state.accepted = null;
          for (const v of state.variations) v.status = "default";
          continue;
        }

        const evRound = typeof ev.round === "number" ? ev.round : state.round;
        if (evRound !== state.round) continue;

        if (ev.type === "verdict") {
          const v = findVariation(ev.variation);
          if (v) {
            v.status = ev.action === "like" ? "liked" : "rejected";
          }
        } else if (ev.type === "accept") {
          if (findVariation(ev.variation)) {
            state.accepted = ev.variation;
          }
        } else if (ev.type === "annotate") {
          state.annotations.push({
            pin: ev.pin,
            variation: ev.variation,
            round: evRound,
            position: ev.position,
            selector: ev.selector || "",
            offset: ev.offset || null,
            shape: ev.shape || "point",
            bounds: ev.bounds || null,
            text: ev.text,
          });
          if (typeof ev.pin === "number" && ev.pin > state.pinCounter) {
            state.pinCounter = ev.pin;
          }
        }
      }

      // Set active variation. If an activeVariation was carried in from
      // the URL hash and still resolves, keep it; otherwise default to
      // the first variation in the current round.
      if (state.variations.length > 0 && !findVariation(state.activeVariation)) {
        state.activeVariation = state.variations[0].variation;
      }
      updateHash();

      // Update prompt display and round badge
      const promptEl = document.getElementById("prompt-display");
      if (promptEl) promptEl.textContent = state.prompt;
      const roundEl = document.getElementById("round-badge");
      if (roundEl) {
        roundEl.textContent = state.round > 0
          ? "Round " + state.round
          : "Waiting...";
      }

      renderCurrentView();
      updateStats();
      updateEmptyState();
    } catch (err) {
      console.error("[forge] loadState error:", err);
    }
  }

  // ─── Iframe bridge injection ───────────────────────────────────────────────

  function injectIframeBridge(iframe) {
    iframe.addEventListener("load", () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        const script = doc.createElement("script");
        script.src = "/iframe-bridge.js";
        doc.body.appendChild(script);

        // Size the iframe to its content. Multiple passes catch late-loading
        // resources (fonts, images) without using a ResizeObserver — those
        // create a feedback loop when variation content uses `min-height: 100vh`.
        resizeIframeToContent(iframe);
        setTimeout(() => resizeIframeToContent(iframe), 100);
        setTimeout(() => resizeIframeToContent(iframe), 500);

        // Re-measure when images inside the iframe finish loading.
        const images = doc.querySelectorAll("img");
        images.forEach((img) => {
          if (!img.complete) {
            img.addEventListener("load", () => resizeIframeToContent(iframe), { once: true });
            img.addEventListener("error", () => resizeIframeToContent(iframe), { once: true });
          }
        });
      } catch (err) {
        // Cross-origin iframes will throw; ignore.
        console.warn("[forge] iframe bridge inject failed:", err);
      }
    });
  }

  function resizeIframeToContent(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (!doc || !doc.body) return;

      // Collapse the iframe first so vh/percent-based content in the
      // variation (e.g. `body { min-height: 100vh }`) doesn't inflate
      // itself to match whatever height we previously set. Without this,
      // measuring scrollHeight yields an ever-growing value.
      iframe.style.height = "0px";

      // Force reflow so the collapsed height takes effect before we measure.
      // Reading offsetHeight triggers layout.
      void doc.body.offsetHeight;

      const height = Math.max(
        doc.body.scrollHeight,
        doc.documentElement.scrollHeight
      );

      // Safety cap — if something goes wrong, don't allow multi-thousand-pixel
      // iframes. Realistic variation content maxes out at a few thousand px.
      const MAX_HEIGHT = 8000;
      iframe.style.height = Math.min(height, MAX_HEIGHT) + "px";
    } catch {
      // Ignore cross-origin errors.
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  function applyView(targetView) {
    if (state.view === targetView) return;
    state.view = targetView;
    document.body.dataset.view = targetView;
    document.querySelectorAll(".view-toggle-btn[data-view]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-view") === targetView);
    });
  }

  function renderCurrentView() {
    if (state.view === "grid") {
      renderGridView();
    } else {
      renderFullView();
    }
  }

  function renderGridView() {
    const container = document.getElementById("grid-container");
    if (!container) return;
    clearChildren(container);

    for (const v of state.variations) {
      container.appendChild(buildPanel(v));
    }
  }

  function buildPanel(v) {
    const panel = document.createElement("div");
    panel.className = "panel";
    if (v.status === "liked") panel.classList.add("liked");
    if (v.status === "rejected") panel.classList.add("rejected");
    if (state.accepted) {
      if (state.accepted === v.variation) panel.classList.add("accepted");
      else panel.classList.add("dimmed");
    }

    // Header
    const header = document.createElement("div");
    header.className = "panel-header";

    const label = document.createElement("div");
    label.className = "panel-label";
    label.textContent = v.variation.toUpperCase() + " — Variation";
    header.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "panel-actions";

    const likeBtn = document.createElement("button");
    likeBtn.className = "panel-action";
    if (v.status === "liked") likeBtn.classList.add("liked");
    likeBtn.textContent = "\u2713"; // ✓
    likeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleVerdict(v.variation, "like");
    });
    actions.appendChild(likeBtn);

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "panel-action";
    if (v.status === "rejected") rejectBtn.classList.add("rejected");
    rejectBtn.textContent = "\u2717"; // ✗
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
        ? "Accepted — click to change your mind"
        : "Accept this as the final pick";
    acceptBtn.textContent = state.accepted === v.variation ? "\uD83D\uDD12" : "Accept"; // 🔒 or "Accept"
    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAccept(v.variation);
    });
    actions.appendChild(acceptBtn);

    header.appendChild(actions);
    panel.appendChild(header);

    // Content
    const content = document.createElement("div");
    content.className = "panel-content";

    const iframe = document.createElement("iframe");
    iframe.src = "/content/" + encodeURIComponent(state.activeTopic) + "/" + v.filename;
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    injectIframeBridge(iframe);
    content.appendChild(iframe);

    const overlay = document.createElement("div");
    overlay.className = "interaction-overlay";
    attachOverlayHandlers(overlay, v.variation, content);
    content.appendChild(overlay);

    panel.appendChild(content);

    // Render annotation pins for this variation (initial, pre-load pass
    // uses fallback positioning; wirePinRerender re-runs post-load).
    renderAnnotationsOnPanel(content, v.variation);
    wirePinRerender(iframe, content, v.variation);

    return panel;
  }

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

  // Cheap check for "did the topic appear?". Safe to call from any
  // fetchTopics (including the WS-reload path that may fire multiple
  // fetches in quick succession). Does NOT tick the timeout counter —
  // that job belongs to tickPendingHashTopic, which the health poll
  // calls on its own 5-second cadence.
  function reconcilePendingHashTopic() {
    if (!state.pendingHashTopic) return;
    const found = state.topics.some((t) => t.id === state.pendingHashTopic);
    if (found) {
      state.pendingHashTopic = null;
      state.pendingHashChecks = 0;
      hideBanner();
    }
  }

  // Periodic tick (~5s). Increments the check counter; after
  // PENDING_HASH_MAX_CHECKS unresolved attempts, falls back to the
  // newest real topic and raises a dismissable banner.
  function tickPendingHashTopic() {
    if (!state.pendingHashTopic) return;
    // Topic may have appeared between ticks — reconcile first.
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

  function renderChipBar() {
    const bar = document.getElementById("chip-bar");
    if (!bar) return;
    // Remove existing chips, keep the label
    const chips = bar.querySelectorAll(".chip");
    chips.forEach((c) => c.remove());

    for (const v of state.variations) {
      const chip = document.createElement("div");
      chip.className = "chip";
      if (v.variation === state.activeVariation) chip.classList.add("active");
      if (v.status === "liked") chip.classList.add("liked");
      if (v.status === "rejected") chip.classList.add("rejected");
      if (state.accepted) {
        if (state.accepted === v.variation) chip.classList.add("accepted");
        else chip.classList.add("dimmed");
      }
      chip.textContent = v.variation.toUpperCase() + " — Variation";

      const count = annotationsFor(v.variation).length;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "chip-annotation-count";
        badge.textContent = String(count);
        chip.appendChild(badge);
      }

      chip.addEventListener("click", () => {
        state.activeVariation = v.variation;
        updateHash();
        renderFullView();
      });

      bar.appendChild(chip);
    }
  }

  function renderFullContent() {
    const container = document.getElementById("full-content");
    if (!container) return;
    clearChildren(container);

    const v = findVariation(state.activeVariation);
    if (!v) return;

    const iframe = document.createElement("iframe");
    iframe.src = "/content/" + encodeURIComponent(state.activeTopic) + "/" + v.filename;
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    injectIframeBridge(iframe);
    container.appendChild(iframe);

    const overlay = document.createElement("div");
    overlay.className = "interaction-overlay";
    attachOverlayHandlers(overlay, v.variation, container);
    container.appendChild(overlay);

    renderAnnotationsOnPanel(container, v.variation);
    wirePinRerender(iframe, container, v.variation);
  }

  function renderNotesSidebar() {
    const list = document.getElementById("notes-list");
    if (!list) return;
    clearChildren(list);

    for (const a of state.annotations) {
      const isGeneral = a.shape === "general" || !a.variation;
      const item = document.createElement("div");
      item.className = isGeneral ? "note-item general" : "note-item";

      const meta = document.createElement("div");
      meta.className = "note-meta";

      const pinRef = document.createElement("span");
      pinRef.className = "note-pin-ref";
      pinRef.textContent = "Note #" + a.pin;
      meta.appendChild(pinRef);

      const varLabel = document.createElement("span");
      varLabel.className = "note-variation";
      varLabel.textContent = isGeneral
        ? "General"
        : "Variation " + a.variation.toUpperCase();
      meta.appendChild(varLabel);

      item.appendChild(meta);

      const text = document.createElement("div");
      text.className = "note-text";
      const v = isGeneral ? null : findVariation(a.variation);
      if (v && v.status === "rejected") text.classList.add("struck");
      text.textContent = a.text;
      item.appendChild(text);

      list.appendChild(item);
    }
  }

  function renderAnnotationsOnPanel(container, variation) {
    // Remove existing pins and area rects
    container
      .querySelectorAll(".annotation-pin, .annotation-area")
      .forEach((el) => el.remove());

    const iframe = container.querySelector("iframe");
    const containerRect = container.getBoundingClientRect();

    for (const a of annotationsFor(variation)) {
      if (a.shape === "area" && a.bounds) {
        renderAreaAnnotation(container, a);
        continue;
      }
      const pin = document.createElement("div");
      pin.className = "annotation-pin";
      pin.textContent = String(a.pin);
      pin.title = a.text;

      const resolved = resolvePinPosition(iframe, container, containerRect, a);
      if (resolved) {
        pin.style.left = resolved.left + "px";
        pin.style.top = resolved.top + "px";
      } else {
        // Fallback: container-fraction positioning. This is the
        // pre-0.3.4 behavior — visible but may dislodge from the
        // original element across view switches.
        pin.style.left = (a.position.x * 100) + "%";
        pin.style.top = (a.position.y * 100) + "%";
      }
      container.appendChild(pin);
    }
  }

  function renderAreaAnnotation(container, a) {
    const rect = document.createElement("div");
    rect.className = "annotation-area";
    rect.style.left = (a.bounds.x * 100) + "%";
    rect.style.top = (a.bounds.y * 100) + "%";
    rect.style.width = (a.bounds.w * 100) + "%";
    rect.style.height = (a.bounds.h * 100) + "%";
    rect.title = a.text;

    const label = document.createElement("div");
    label.className = "annotation-area-label";
    label.textContent = String(a.pin);
    rect.appendChild(label);

    container.appendChild(rect);
  }

  // Computes a pin's pixel position within the container by resolving the
  // annotation's stored selector against the current iframe DOM, then
  // adding the stored offset-within-element. Same-origin iframe access
  // means this is synchronous. Returns null when the selector can't be
  // resolved (iframe not loaded, element missing, or legacy annotation
  // with no selector).
  function resolvePinPosition(iframe, container, containerRect, a) {
    if (!iframe || !a.selector || !a.offset) return null;
    const doc = iframe.contentDocument;
    if (!doc) return null;
    let el = null;
    try {
      el = doc.querySelector(a.selector);
    } catch {
      return null;
    }
    if (!el) return null;

    const elRect = el.getBoundingClientRect();
    const iframeRect = iframe.getBoundingClientRect();

    // Element rect is in the iframe's viewport coords; translate to the
    // container's coord system. The overlay container is `position:
    // relative` and the iframe fills it, so this lands the pin exactly
    // where the element sits on screen, regardless of reflow.
    const left =
      (iframeRect.left - containerRect.left) +
      elRect.left +
      a.offset.fx * elRect.width;
    const top =
      (iframeRect.top - containerRect.top) +
      elRect.top +
      a.offset.fy * elRect.height;

    return { left, top };
  }

  // Attaches a load listener that re-renders pins after the iframe
  // content finishes laying out. Called from both grid and full builders.
  // The pin-render path is idempotent, so multiple calls are safe.
  function wirePinRerender(iframe, container, variation) {
    const rerender = () => renderAnnotationsOnPanel(container, variation);
    iframe.addEventListener("load", () => {
      rerender();
      // Content may reflow when resizeIframeToContent runs at 100ms/500ms;
      // schedule pin re-renders after those settle.
      setTimeout(rerender, 150);
      setTimeout(rerender, 600);
    });
  }

  // ─── Interaction handlers ──────────────────────────────────────────────────

  // Wires click (select/annotate modes) and drag (area mode) on the
  // overlay. The overlay is recreated on every render, so handlers are
  // always fresh — no cleanup needed.
  function attachOverlayHandlers(overlay, variation, container) {
    overlay.addEventListener("click", (e) => {
      if (state.mode === "area") return; // area uses drag, not click
      handleOverlayClick(e, variation, container);
    });
    overlay.addEventListener("mousedown", (e) => {
      if (state.mode !== "area") return;
      if (e.button !== 0) return;
      e.preventDefault();
      startAreaDrag(e, variation, container, overlay);
    });
  }

  function startAreaDrag(event, variation, container, overlay) {
    const rect = container.getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;

    const rectEl = document.createElement("div");
    rectEl.className = "annotation-area dragging";
    rectEl.style.left = startX + "px";
    rectEl.style.top = startY + "px";
    rectEl.style.width = "0px";
    rectEl.style.height = "0px";
    container.appendChild(rectEl);

    areaDrag = {
      variation,
      container,
      startX,
      startY,
      currentX: startX,
      currentY: startY,
      rectEl,
      onMove: null,
      onUp: null,
    };

    // Use window-level listeners so the drag continues even when the
    // pointer leaves the overlay (matches selection-box UX in IDEs).
    areaDrag.onMove = (e) => updateAreaDrag(e);
    areaDrag.onUp = (e) => endAreaDrag(e);
    window.addEventListener("mousemove", areaDrag.onMove);
    window.addEventListener("mouseup", areaDrag.onUp, { once: true });
  }

  function updateAreaDrag(event) {
    if (!areaDrag) return;
    const rect = areaDrag.container.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const y = clamp(event.clientY - rect.top, 0, rect.height);
    areaDrag.currentX = x;
    areaDrag.currentY = y;

    const left = Math.min(areaDrag.startX, x);
    const top = Math.min(areaDrag.startY, y);
    const width = Math.abs(x - areaDrag.startX);
    const height = Math.abs(y - areaDrag.startY);

    areaDrag.rectEl.style.left = left + "px";
    areaDrag.rectEl.style.top = top + "px";
    areaDrag.rectEl.style.width = width + "px";
    areaDrag.rectEl.style.height = height + "px";
  }

  function endAreaDrag(event) {
    if (!areaDrag) return;
    const drag = areaDrag;
    areaDrag = null;
    window.removeEventListener("mousemove", drag.onMove);

    const rect = drag.container.getBoundingClientRect();
    const width = Math.abs(drag.currentX - drag.startX);
    const height = Math.abs(drag.currentY - drag.startY);

    // Reject noise drags — a slip of the mouse shouldn't open a popup.
    const MIN = 12;
    if (width < MIN || height < MIN) {
      drag.rectEl.remove();
      return;
    }

    const left = Math.min(drag.startX, drag.currentX);
    const top = Math.min(drag.startY, drag.currentY);

    // Store bounds as fractions of the container. The iframe fills the
    // container at 100% width with height = content scrollHeight, so
    // container fractions equal content fractions in our layout. On
    // re-render (different view, different container size) we multiply
    // back by the current container rect.
    const bounds = {
      x: left / rect.width,
      y: top / rect.height,
      w: width / rect.width,
      h: height / rect.height,
    };

    // Freeze the visible rect and attach the text input next to it. The
    // rect is part of the container; the popup uses viewport coords.
    drag.rectEl.classList.remove("dragging");
    showAreaInput(
      event.clientX,
      event.clientY,
      drag.variation,
      bounds,
      drag.rectEl
    );
  }

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function showAreaInput(clientX, clientY, variation, bounds, tempRectEl) {
    const existing = document.querySelector(".annotation-input");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.className = "annotation-input";
    popup.style.position = "fixed";
    popup.style.left = (clientX + 10) + "px";
    popup.style.top = (clientY - 20) + "px";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Describe this region...";
    popup.appendChild(input);

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    popup.appendChild(addBtn);

    document.body.appendChild(popup);
    input.focus();

    function cancel() {
      popup.remove();
      tempRectEl.remove();
    }

    function submit() {
      const text = input.value.trim();
      if (!text) {
        cancel();
        return;
      }
      state.pinCounter += 1;
      const annotation = {
        pin: state.pinCounter,
        variation,
        round: state.round,
        position: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
        selector: "",
        offset: null,
        shape: "area",
        bounds,
        text,
      };
      state.annotations.push(annotation);

      postEvent({
        type: "annotate",
        variation,
        round: annotation.round,
        pin: annotation.pin,
        position: annotation.position,
        selector: annotation.selector,
        text: annotation.text,
        shape: "area",
        bounds,
      });

      popup.remove();
      tempRectEl.remove();
      renderCurrentView();
      updateStats();
    }

    function onKey(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    }

    input.addEventListener("keydown", onKey);
    addBtn.addEventListener("click", submit);
  }

  function handleOverlayClick(event, variation, container) {
    const rect = container.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const relX = localX / rect.width;
    const relY = localY / rect.height;

    if (state.mode === "annotate") {
      // Show the input popup first (clears any stale pending click).
      showAnnotationInput(event.clientX, event.clientY, variation);

      // Then open a pending-click record the iframe can patch. The
      // clickId guards against a late reply from a previous click
      // landing on the current record after the user moved on.
      const clickId = ++annotateClickSeq;
      pendingAnnotateClick = {
        clickId,
        variation,
        container,
        fallback: { x: relX, y: relY },
        selector: null,
        offset: null,
      };
      const iframe = container.querySelector("iframe");
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          { type: "forge-annotate-click", clickId, x: localX, y: localY },
          "*"
        );
      }
    } else if (state.mode === "select") {
      const iframe = container.querySelector("iframe");
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          { type: "forge-click", x: localX, y: localY },
          "*"
        );
      }
    }
  }

  function showAnnotationInput(clientX, clientY, variation) {
    // Remove any existing popup
    const existing = document.querySelector(".annotation-input");
    if (existing) {
      existing.remove();
      // Also clear any stale pending click — the new click supersedes it.
      pendingAnnotateClick = null;
    }

    const popup = document.createElement("div");
    popup.className = "annotation-input";
    popup.style.position = "fixed";
    popup.style.left = (clientX + 10) + "px";
    popup.style.top = (clientY - 20) + "px";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Add note...";
    popup.appendChild(input);

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    popup.appendChild(addBtn);

    document.body.appendChild(popup);
    input.focus();

    function submit() {
      const text = input.value.trim();
      if (!text) {
        popup.remove();
        pendingAnnotateClick = null;
        return;
      }
      state.pinCounter += 1;

      // Pull iframe-resolved data if the iframe responded in time;
      // otherwise fall back to container-fraction coordinates only. The
      // annotation will still render via the fallback path, just without
      // element-reanchoring on reflow.
      const pending = pendingAnnotateClick;
      const selector = pending?.selector ?? "";
      const offset = pending?.offset ?? null;
      const fallback = pending?.fallback ?? { x: 0.5, y: 0.5 };

      const annotation = {
        pin: state.pinCounter,
        variation,
        round: state.round,
        position: fallback,
        selector,
        offset,
        text,
      };
      state.annotations.push(annotation);
      pendingAnnotateClick = null;

      postEvent({
        type: "annotate",
        variation,
        round: annotation.round,
        pin: annotation.pin,
        position: annotation.position,
        selector: annotation.selector,
        offset: annotation.offset ?? undefined,
        text: annotation.text,
      });

      popup.remove();
      renderCurrentView();
      updateStats();
    }

    function onKey(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        popup.remove();
      }
    }

    input.addEventListener("keydown", onKey);
    addBtn.addEventListener("click", submit);
  }

  function handleAccept(variation) {
    const v = findVariation(variation);
    if (!v) return;

    // Idempotent: re-clicking the already-accepted variation is a no-op.
    // Clicking Accept on a different variation overwrites the prior
    // pick (last-write-wins) — matches the documented event semantics
    // ("change your mind before the consumer processed it"). There is
    // intentionally no unaccept event; the only way out is to pick a
    // different variation or to start a new round.
    if (state.accepted === variation) return;

    state.accepted = variation;
    postEvent({
      type: "accept",
      variation,
      round: state.round,
    });

    renderCurrentView();
    updateStats();
  }

  function handleVerdict(variation, action) {
    const v = findVariation(variation);
    if (!v) return;

    const targetStatus = action === "like" ? "liked" : "rejected";
    if (v.status === targetStatus) {
      // Toggle off — no event posted
      v.status = "default";
    } else {
      v.status = targetStatus;
      postEvent({
        type: "verdict",
        variation,
        round: state.round,
        action,
      });
    }

    renderCurrentView();
    updateStats();
  }

  // ─── Iframe message listener (bridge responses) ───────────────────────────

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.source !== "forge-iframe") return;
    const { type, selector, label } = event.data;

    // Annotate mode: iframe reports the element that was under the click
    // plus the click's offset within that element. Only patch when the
    // clickId matches — a late reply from a superseded click would
    // otherwise overwrite the current record with stale data.
    if (type === "annotate-resolved") {
      if (
        pendingAnnotateClick &&
        pendingAnnotateClick.clickId === event.data.clickId
      ) {
        pendingAnnotateClick.selector = selector || null;
        pendingAnnotateClick.offset = event.data.offset || null;
      }
      return;
    }

    if (type !== "element-selected") return;
    if (state.mode !== "select") return;

    // Determine which variation this message came from by matching the
    // iframe's contentWindow against known iframes.
    const iframes = document.querySelectorAll("iframe");
    let variation = null;
    for (const ifr of iframes) {
      if (ifr.contentWindow === event.source) {
        const src = ifr.getAttribute("src") || "";
        // Strip the topic segment (if present) before parsing. We accept
        // both /content/<topic>/<file> and the legacy /content/<file>.
        const filename = src.replace(/^\/content\/[^/]+\//, "")
          .replace(/^\/content\//, "");
        const parsed = parseFilename(filename);
        if (parsed) variation = parsed.variation;
        break;
      }
    }
    if (!variation) return;

    postEvent({
      type: "select",
      variation,
      round: state.round,
      selector,
      label,
      action: "like",
    });
  });

  // ─── Toolbar / view wiring ─────────────────────────────────────────────────

  function wireToolbar() {
    // Mode buttons
    const modeBtns = document.querySelectorAll(".tool-btn[data-mode]");
    modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        if (!mode) return;
        state.mode = mode;
        document.body.dataset.mode = mode;
        modeBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    // View toggle buttons
    const viewBtns = document.querySelectorAll(".view-toggle-btn[data-view]");
    viewBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.getAttribute("data-view");
        if (!view) return;
        applyView(view);
        updateHash();
        renderCurrentView();
      });
    });
  }

  function wireFeedbackBar() {
    const clearBtn = document.getElementById("btn-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        state.annotations = [];
        state.pinCounter = 0;
        for (const v of state.variations) v.status = "default";
        renderCurrentView();
        updateStats();
      });
    }

    const sendBtn = document.getElementById("btn-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", async () => {
        const summary = buildSummary();
        try {
          await navigator.clipboard.writeText(summary);
          const original = sendBtn.textContent;
          sendBtn.textContent = "Copied!";
          setTimeout(() => {
            sendBtn.textContent = original;
          }, 1500);
        } catch (err) {
          console.error("[forge] clipboard write failed:", err);
        }
      });
    }

    const refineBtn = document.getElementById("btn-refine");
    if (refineBtn) {
      refineBtn.addEventListener("click", async () => {
        refineBtn.disabled = true;
        const original = refineBtn.textContent;
        refineBtn.textContent = "Refining...";

        // Post a refine event. The bridge forwards it to stdout and the
        // UserPromptSubmit hook picks it up on the developer's next message.
        await postEvent({ type: "refine" });

        // Show a transient toast telling the developer what to do next.
        showRefineToast();

        setTimeout(() => {
          refineBtn.textContent = original;
          refineBtn.disabled = false;
        }, 1500);
      });
    }
  }

  function showRefineToast() {
    showToast(
      "Refine requested. If Claude Code is running with --channels, you'll get a live response. Otherwise, send any message to your Claude session and the hook will inject your feedback."
    );
  }

  function showToast(message, durationMs) {
    durationMs = durationMs || 6000;
    // Remove any existing toast
    document.querySelectorAll(".forge-toast").forEach((t) => t.remove());

    const toast = document.createElement("div");
    toast.className = "forge-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("visible"));

    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  function buildSummary() {
    const lines = [];
    lines.push("forge feedback summary (round " + state.round + ")");
    if (state.prompt) lines.push("Prompt: " + state.prompt);
    lines.push("");

    for (const v of state.variations) {
      if (v.status !== "default") {
        lines.push(
          "Variation " + v.variation.toUpperCase() + ": " + v.status
        );
      }
    }
    if (state.annotations.length > 0) {
      lines.push("");
      lines.push("Annotations:");
      for (const a of state.annotations) {
        lines.push(
          "  Pin #" + a.pin +
          " (Variation " + a.variation.toUpperCase() + "): " +
          a.text
        );
      }
    }
    return lines.join("\n");
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  function updateStats() {
    const selected = state.variations.filter((v) => v.status === "liked").length;
    const rejected = state.variations.filter((v) => v.status === "rejected").length;

    const sel = document.getElementById("stat-selected");
    if (sel) sel.textContent = String(selected);
    const ann = document.getElementById("stat-annotations");
    if (ann) ann.textContent = String(state.annotations.length);
    const rej = document.getElementById("stat-rejected");
    if (rej) rej.textContent = String(rejected);
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  function connectWebSocket() {
    try {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(protocol + "//" + location.host + "/ws");
      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.type === "reload") {
            // Reload events are scoped to a topic (files changed inside
            // content/<topicId>/). Refresh topics either way so a new
            // one shows up in the tab bar; only reload the main view
            // when the change is in the topic we're currently showing.
            fetchTopics().then(() => {
              renderTopicTabs();
              updateEmptyState();
              if (!msg.topicId || msg.topicId === state.activeTopic) {
                loadState();
              }
            });
          } else if (msg && msg.type === "toast" && typeof msg.message === "string") {
            showToast(msg.message);
          }
        } catch {
          // Ignore parse errors
        }
      });
      ws.addEventListener("close", () => {
        setTimeout(connectWebSocket, 3000);
      });
      ws.addEventListener("error", () => {
        // Let close handler schedule reconnect.
      });
    } catch (err) {
      console.error("[forge] WebSocket error:", err);
      setTimeout(connectWebSocket, 3000);
    }
  }

  // ─── Channel health polling ────────────────────────────────────────────────

  function setChannelStatus(status) {
    const badge = document.getElementById("channel-badge");
    if (!badge) return;

    badge.className = "topbar-badge";

    const sendBtn = document.getElementById("btn-send");
    const refineBtn = document.getElementById("btn-refine");

    if (status === "live") {
      badge.classList.add("live");
      badge.textContent = "\u25CF Channel Live";
      if (sendBtn) sendBtn.style.display = "none";
      if (refineBtn) refineBtn.style.display = "";
    } else if (status === "reconnecting") {
      badge.classList.add("reconnecting");
      badge.textContent = "\u25CF Reconnecting...";
      if (sendBtn) sendBtn.style.display = "none";
      if (refineBtn) refineBtn.style.display = "";
    } else if (status === "disconnected") {
      badge.classList.add("disconnected");
      badge.textContent = "\u25CF Disconnected — feedback queued";
      if (sendBtn) sendBtn.style.display = "";
      if (refineBtn) refineBtn.style.display = "none";
    }
  }

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
        tickPendingHashTopic();
        renderTopicTabs();
      }
    }
    setInterval(poll, 5000);
    poll();
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    wireToolbar();
    wireFeedbackBar();
    wireGeneralNote();
    wireShareButton();

    // Honor URL hash on boot. Setting activeTopic here (before loadState)
    // means the first fetch targets the hashed topic, not the default.
    // pendingHashTopic stays set until fetchTopics confirms the topic
    // exists; see reconcilePendingHashTopic / tickPendingHashTopic.
    const parsed = parseHash(location.hash);
    if (parsed.topicId) {
      state.activeTopic = parsed.topicId;
      state.hasExplicitTopic = true;
      state.pendingHashTopic = parsed.topicId;
    }
    if (parsed.variation) {
      state.activeVariation = parsed.variation;
      applyView("full");
    }

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
      // Navigating to a different topic always clears any prior pending
      // pointer — otherwise a stale "Loading topic-a..." banner from a
      // previous paste could fall through to a "not found" fallback for
      // the wrong topic once MAX ticks elapse.
      const known = state.topics.some((t) => t.id === topicId);
      if (known) {
        state.pendingHashTopic = null;
        state.pendingHashChecks = 0;
        hideBanner();
      } else {
        state.pendingHashTopic = topicId;
        state.pendingHashChecks = 0;
      }
      renderTopicTabs();
      await loadState();
    }

    // After loadState, the variation letter may or may not exist.
    if (variation) {
      if (findVariation(variation)) {
        state.activeVariation = variation;
        applyView("full");
      } else {
        // Unknown variation letter for this topic → fall back to grid.
        applyView("grid");
      }
    } else {
      // No variation in the new hash → grid view.
      applyView("grid");
    }

    // Write the final URL after all state transitions are applied — this
    // overrides any interim hash that loadState may have written when the
    // variation hadn't been resolved yet. Idempotent when the hash is
    // already in sync.
    updateHash();
    renderCurrentView();
  }

  function wireGeneralNote() {
    const textarea = document.getElementById("general-note");
    const submitBtn = document.getElementById("general-note-submit");
    if (!textarea || !submitBtn) return;

    function submit() {
      const text = textarea.value.trim();
      if (!text) return;
      state.pinCounter += 1;
      const annotation = {
        pin: state.pinCounter,
        // General notes aren't tied to a variation; empty string keeps
        // annotationsFor(letter) from matching them as pins.
        variation: "",
        round: state.round,
        position: { x: 0, y: 0 },
        selector: "",
        offset: null,
        shape: "general",
        bounds: null,
        text,
      };
      state.annotations.push(annotation);

      postEvent({
        type: "annotate",
        variation: "",
        round: annotation.round,
        pin: annotation.pin,
        position: annotation.position,
        selector: "",
        text: annotation.text,
        shape: "general",
      });

      textarea.value = "";
      renderNotesSidebar();
      updateStats();
    }

    submitBtn.addEventListener("click", submit);
    textarea.addEventListener("keydown", (e) => {
      // Cmd/Ctrl+Enter submits. Plain Enter inserts a newline (textarea
      // default) so multi-line notes are easy.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
  }

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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
