const els = {
  similarityMode: document.getElementById("similarityMode"),
  includeSnippet: document.getElementById("includeSnippet"),
  aiLabeling: document.getElementById("aiLabeling"),
  localThreshold: document.getElementById("localThreshold"),
  localThresholdValue: document.getElementById("localThresholdValue"),
  embeddingsThreshold: document.getElementById("embeddingsThreshold"),
  embeddingsThresholdValue: document.getElementById("embeddingsThresholdValue"),
  embeddingsEndpoint: document.getElementById("embeddingsEndpoint"),
  embeddingsApiKey: document.getElementById("embeddingsApiKey"),
  excludedDomains: document.getElementById("excludedDomains"),
  includePinned: document.getElementById("includePinned"),
  includeAudible: document.getElementById("includeAudible"),
  parkingMode: document.getElementById("parkingMode"),
  autoAiGroupSchedule: document.getElementById("autoAiGroupSchedule"),
  status: document.getElementById("status"),
  embeddingsCard: document.getElementById("embeddingsCard")
};

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function sendMessage(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Operation failed."));
        return;
      }
      resolve(response.result || {});
    });
  });
}

function parseExcludedDomains(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function updateThresholdLabels() {
  els.localThresholdValue.textContent = Number(els.localThreshold.value).toFixed(2);
  els.embeddingsThresholdValue.textContent = Number(els.embeddingsThreshold.value).toFixed(2);
}

function updateEmbeddingsVisibility() {
  const mode = els.similarityMode.value;
  els.embeddingsCard.style.opacity = mode === "embeddings" ? "1" : "0.65";
}

function isValidEndpoint(url) {
  if (!url) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    return parsed.protocol === "https:" || local;
  } catch (_err) {
    return false;
  }
}

function renderSettings(settings) {
  els.similarityMode.value = settings.similarityMode || "local";
  els.includeSnippet.checked = Boolean(settings.includeSnippet);
  els.aiLabeling.checked = Boolean(settings.aiLabeling);
  els.localThreshold.value = settings.localThreshold ?? 0.35;
  els.embeddingsThreshold.value = settings.embeddingsThreshold ?? 0.82;
  els.embeddingsEndpoint.value = settings.embeddingsEndpoint || "";
  els.embeddingsApiKey.value = settings.embeddingsApiKey || "";
  els.excludedDomains.value = (settings.excludedDomains || []).join("\n");
  els.includePinned.checked = Boolean(settings.includePinned);
  els.includeAudible.checked = Boolean(settings.includeAudible);
  els.parkingMode.value = settings.parkingMode || "append";
  els.autoAiGroupSchedule.value = settings.autoAiGroupSchedule || "off";

  updateThresholdLabels();
  updateEmbeddingsVisibility();
}

function collectSettings() {
  return {
    similarityMode: els.similarityMode.value,
    includeSnippet: els.includeSnippet.checked,
    aiLabeling: els.aiLabeling.checked,
    localThreshold: Number(els.localThreshold.value),
    embeddingsThreshold: Number(els.embeddingsThreshold.value),
    embeddingsEndpoint: els.embeddingsEndpoint.value.trim(),
    embeddingsApiKey: els.embeddingsApiKey.value,
    excludedDomains: parseExcludedDomains(els.excludedDomains.value),
    includePinned: els.includePinned.checked,
    includeAudible: els.includeAudible.checked,
    parkingMode: els.parkingMode.value,
    autoAiGroupSchedule: els.autoAiGroupSchedule.value
  };
}

async function loadSettings() {
  const { settings } = await sendMessage("GET_SETTINGS");
  renderSettings(settings);
}

async function onSave() {
  const settings = collectSettings();

  if (settings.similarityMode === "embeddings") {
    if (!settings.embeddingsEndpoint) {
      setStatus("Embeddings endpoint is required when embeddings mode is selected.", "error");
      return;
    }
    if (!isValidEndpoint(settings.embeddingsEndpoint)) {
      setStatus("Embeddings endpoint must be https:// unless using localhost.", "error");
      return;
    }
  }

  try {
    const { settings: saved } = await sendMessage("SAVE_SETTINGS", { settings });
    renderSettings(saved);
    setStatus("Settings saved.", "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onClearSessions() {
  const confirmed = window.confirm("Delete all saved sessions? This cannot be undone.");
  if (!confirmed) {
    return;
  }

  try {
    await sendMessage("CLEAR_SESSIONS");
    setStatus("Saved sessions cleared.", "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

els.localThreshold.addEventListener("input", updateThresholdLabels);
els.embeddingsThreshold.addEventListener("input", updateThresholdLabels);
els.similarityMode.addEventListener("change", updateEmbeddingsVisibility);
document.getElementById("saveBtn").addEventListener("click", onSave);
document.getElementById("clearSessionsBtn").addEventListener("click", onClearSessions);

(async () => {
  try {
    await loadSettings();
    setStatus("Ready.");
  } catch (err) {
    setStatus(err.message, "error");
  }
})();
