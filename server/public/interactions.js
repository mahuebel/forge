// forge workspace interactions — Grid/Full views, modes, iframe bridge
(function () {
  "use strict";

  // ─── State ─────────────────────────────────────────────────────────────────

  const state = {
    view: "grid",           // "grid" | "full"
    mode: "select",         // "select" | "annotate"
    variations: [],         // [{filename, round, variation, status}]
    activeVariation: null,  // letter
    annotations: [],        // [{pin, variation, position, selector, text}]
    pinCounter: 0,
    connected: false,
    round: 0,
    prompt: "",
  };

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
    return state.annotations.filter((a) => a.variation === letter);
  }

  function clearChildren(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  // ─── API ───────────────────────────────────────────────────────────────────

  async function postEvent(eventData) {
    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventData),
      });
      if (!res.ok) {
        console.error("[forge] postEvent failed:", res.status);
      }
    } catch (err) {
      console.error("[forge] postEvent error:", err);
    }
  }

  async function loadState() {
    try {
      const [stateRes, eventsRes] = await Promise.all([
        fetch("/api/state"),
        fetch("/api/events"),
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
      for (const ev of events) {
        if (ev.type === "round") {
          state.round = ev.round;
          state.prompt = ev.prompt || "";
          state.annotations = [];
          state.pinCounter = 0;
          for (const v of state.variations) v.status = "default";
        } else if (ev.type === "verdict") {
          const v = findVariation(ev.variation);
          if (v) {
            v.status = ev.action === "like" ? "liked" : "rejected";
          }
        } else if (ev.type === "annotate") {
          state.annotations.push({
            pin: ev.pin,
            variation: ev.variation,
            position: ev.position,
            selector: ev.selector,
            text: ev.text,
          });
          if (typeof ev.pin === "number" && ev.pin > state.pinCounter) {
            state.pinCounter = ev.pin;
          }
        }
      }

      // Set active variation
      if (state.variations.length > 0 && !findVariation(state.activeVariation)) {
        state.activeVariation = state.variations[0].variation;
      }

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

    header.appendChild(actions);
    panel.appendChild(header);

    // Content
    const content = document.createElement("div");
    content.className = "panel-content";

    const iframe = document.createElement("iframe");
    iframe.src = "/content/" + v.filename;
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    injectIframeBridge(iframe);
    content.appendChild(iframe);

    const overlay = document.createElement("div");
    overlay.className = "interaction-overlay";
    overlay.addEventListener("click", (e) => {
      handleOverlayClick(e, v.variation, content);
    });
    content.appendChild(overlay);

    panel.appendChild(content);

    // Render annotation pins for this variation
    renderAnnotationsOnPanel(content, v.variation);

    return panel;
  }

  function renderFullView() {
    renderChipBar();
    renderFullContent();
    renderNotesSidebar();
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
    iframe.src = "/content/" + v.filename;
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    injectIframeBridge(iframe);
    container.appendChild(iframe);

    const overlay = document.createElement("div");
    overlay.className = "interaction-overlay";
    overlay.addEventListener("click", (e) => {
      handleOverlayClick(e, v.variation, container);
    });
    container.appendChild(overlay);

    renderAnnotationsOnPanel(container, v.variation);
  }

  function renderNotesSidebar() {
    const list = document.getElementById("notes-list");
    if (!list) return;
    clearChildren(list);

    for (const a of state.annotations) {
      const item = document.createElement("div");
      item.className = "note-item";

      const meta = document.createElement("div");
      meta.className = "note-meta";

      const pinRef = document.createElement("span");
      pinRef.className = "note-pin-ref";
      pinRef.textContent = "Pin #" + a.pin;
      meta.appendChild(pinRef);

      const varLabel = document.createElement("span");
      varLabel.className = "note-variation";
      varLabel.textContent = "Variation " + a.variation.toUpperCase();
      meta.appendChild(varLabel);

      item.appendChild(meta);

      const text = document.createElement("div");
      text.className = "note-text";
      const v = findVariation(a.variation);
      if (v && v.status === "rejected") text.classList.add("struck");
      text.textContent = a.text;
      item.appendChild(text);

      list.appendChild(item);
    }
  }

  function renderAnnotationsOnPanel(container, variation) {
    // Remove existing pins
    const existing = container.querySelectorAll(".annotation-pin");
    existing.forEach((el) => el.remove());

    for (const a of annotationsFor(variation)) {
      const pin = document.createElement("div");
      pin.className = "annotation-pin";
      pin.textContent = String(a.pin);
      pin.style.left = (a.position.x * 100) + "%";
      pin.style.top = (a.position.y * 100) + "%";
      pin.title = a.text;
      container.appendChild(pin);
    }
  }

  // ─── Interaction handlers ──────────────────────────────────────────────────

  function handleOverlayClick(event, variation, container) {
    const rect = container.getBoundingClientRect();
    const relX = (event.clientX - rect.left) / rect.width;
    const relY = (event.clientY - rect.top) / rect.height;

    if (state.mode === "annotate") {
      showAnnotationInput(
        event.clientX,
        event.clientY,
        relX,
        relY,
        variation,
        container
      );
    } else if (state.mode === "select") {
      const iframe = container.querySelector("iframe");
      if (iframe && iframe.contentWindow) {
        const localX = event.clientX - rect.left;
        const localY = event.clientY - rect.top;
        iframe.contentWindow.postMessage(
          { type: "forge-click", x: localX, y: localY },
          "*"
        );
      }
    }
  }

  function showAnnotationInput(clientX, clientY, relX, relY, variation, container) {
    // Remove any existing popup
    const existing = document.querySelector(".annotation-input");
    if (existing) existing.remove();

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
        return;
      }
      state.pinCounter += 1;
      const annotation = {
        pin: state.pinCounter,
        variation,
        position: { x: relX, y: relY },
        selector: "",
        text,
      };
      state.annotations.push(annotation);

      postEvent({
        type: "annotate",
        variation,
        pin: annotation.pin,
        position: annotation.position,
        selector: annotation.selector,
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
    if (type !== "element-selected") return;
    if (state.mode !== "select") return;

    // Determine which variation this message came from by matching the
    // iframe's contentWindow against known iframes.
    const iframes = document.querySelectorAll("iframe");
    let variation = null;
    for (const ifr of iframes) {
      if (ifr.contentWindow === event.source) {
        const src = ifr.getAttribute("src") || "";
        const filename = src.replace(/^\/content\//, "");
        const parsed = parseFilename(filename);
        if (parsed) variation = parsed.variation;
        break;
      }
    }
    if (!variation) return;

    postEvent({
      type: "select",
      variation,
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
        state.view = view;
        document.body.dataset.view = view;
        viewBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
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
            loadState();
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
    }
    setInterval(poll, 5000);
    poll();
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    wireToolbar();
    wireFeedbackBar();
    loadState();
    connectWebSocket();
    startHealthPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
