// server/public/iframe-bridge.js
(function () {
  "use strict";

  const SEMANTIC_TAGS = new Set([
    "nav", "header", "section", "article", "aside",
    "main", "form", "table", "ul", "ol", "footer",
  ]);

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "forge-click") return;
    const { x, y } = event.data;
    const element = document.elementFromPoint(x, y);
    if (!element) return;

    const meaningful = findMeaningfulElement(element);
    const label = getLabel(meaningful);
    const selector = getSelector(meaningful);

    window.parent.postMessage(
      { source: "forge-iframe", type: "element-selected", selector, label },
      "*"
    );
  });

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

  function getSelector(el) {
    if (el.id) return "#" + el.id;
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === "string") {
      return tag + "." + el.className.split(/\s+/).join(".");
    }
    return tag;
  }
})();
