// server/public/iframe-bridge.js
//
// Runs inside each variation iframe. Handles two parent→iframe messages:
//
// - `forge-click` (select mode): identify the semantically meaningful
//   element at (x, y) and post back a selector + label.
//
// - `forge-annotate-click` (annotate mode): same lookup, but also report
//   the click offset within the element (as fractions of its bounding
//   box) so the parent can re-anchor pins to the element when the iframe
//   reflows between Grid and Full views.
//
// The selector is a stable nth-of-type path from body, not a class list —
// classes alone aren't unique enough to re-resolve reliably, and we care
// about "the element that was clicked in this exact HTML doc", not about
// semantic class names.

(function () {
  "use strict";

  const SEMANTIC_TAGS = new Set([
    "nav", "header", "section", "article", "aside",
    "main", "form", "table", "ul", "ol", "footer",
  ]);

  window.addEventListener("message", (event) => {
    if (!event.data) return;

    if (event.data.type === "forge-click") {
      handleClick(event.data.x, event.data.y, /* annotate */ false, null);
    } else if (event.data.type === "forge-annotate-click") {
      handleClick(event.data.x, event.data.y, /* annotate */ true, event.data.clickId);
    }
  });

  function handleClick(x, y, annotate, clickId) {
    const raw = document.elementFromPoint(x, y);
    if (!raw) return;

    const meaningful = findMeaningfulElement(raw);
    const label = getLabel(meaningful);
    const selector = buildPathSelector(meaningful);
    const rect = meaningful.getBoundingClientRect();

    if (annotate) {
      // Offset within element as 0..1 fractions; clamped so clicks on the
      // exact edge don't round outside the element.
      const fx = rect.width > 0 ? clamp01((x - rect.left) / rect.width) : 0.5;
      const fy = rect.height > 0 ? clamp01((y - rect.top) / rect.height) : 0.5;

      window.parent.postMessage(
        {
          source: "forge-iframe",
          type: "annotate-resolved",
          clickId,
          selector,
          label,
          offset: { fx, fy },
          contentPoint: { x, y },
        },
        "*"
      );
    } else {
      window.parent.postMessage(
        { source: "forge-iframe", type: "element-selected", selector, label },
        "*"
      );
    }
  }

  function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
  }

  function findMeaningfulElement(el) {
    let current = el;
    while (current && current !== document.body) {
      if (SEMANTIC_TAGS.has(current.tagName.toLowerCase())) return current;
      if (current.className && typeof current.className === "string" && current.className.trim()) return current;
      if (current.dataset && Object.keys(current.dataset).length > 0) return current;
      current = current.parentElement;
    }
    return el;
  }

  function getLabel(el) {
    if (el.dataset.label) return el.dataset.label;
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const text = el.textContent?.trim();
    if (text && text.length <= 60) return text;
    if (text) return text.slice(0, 57) + "...";
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.split(/\s+/)[0]
      : "";
    return tag + cls;
  }

  // Builds a selector that uniquely identifies the element by walking up
  // the tree and recording tag + nth-of-type at each level. IDs short-circuit
  // the walk when present, since they're globally unique within the document.
  function buildPathSelector(el) {
    if (el.id) return "#" + cssEscape(el.id);

    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length === 1) {
        parts.unshift(tag);
      } else {
        const idx = siblings.indexOf(current) + 1;
        parts.unshift(tag + ":nth-of-type(" + idx + ")");
      }
      current = parent;
    }
    return "body > " + parts.join(" > ");
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(s);
    }
    return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  }
})();
