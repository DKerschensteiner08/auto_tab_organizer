(() => {
  const MAX_SNIPPET = 800;

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getMetaDescription() {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    return cleanText(meta?.content || "");
  }

  function getBodySnippet() {
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
    if (message?.action !== "GET_SNIPPET") {
      return;
    }

    const meta = getMetaDescription();
    const fallback = getBodySnippet();
    const chosen = meta || fallback;

    sendResponse({
      ok: true,
      snippet: chosen.slice(0, MAX_SNIPPET)
    });
  });
})();
