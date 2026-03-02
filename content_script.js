(() => {
  const MAX_SNIPPET = 800;

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function fromMetaDescription() {
    const node = document.querySelector('meta[name="description"], meta[property="og:description"]');
    return cleanText(node?.content || "");
  }

  function fromVisibleText() {
    const selectors = ["main", "article", "section", "p", "div"];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = cleanText(node.textContent || "");
        if (text.length >= 80) {
          return text;
        }
      }
    }
    return cleanText(document.body?.innerText || "");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "GET_SNIPPET") {
      return;
    }

    const snippet = (fromMetaDescription() || fromVisibleText()).slice(0, MAX_SNIPPET);
    sendResponse({ ok: true, snippet });
  });
})();
