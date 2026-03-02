const els = {
  aiGroupingEnabled: document.getElementById("aiGroupingEnabled"),
  similarityThreshold: document.getElementById("similarityThreshold"),
  similarityThresholdValue: document.getElementById("similarityThresholdValue"),
  includeSnippet: document.getElementById("includeSnippet"),
  openaiApiKey: document.getElementById("openaiApiKey"),
  embeddingsModel: document.getElementById("embeddingsModel"),
  aiLabeling: document.getElementById("aiLabeling"),
  excludedDomains: document.getElementById("excludedDomains"),
  includePinned: document.getElementById("includePinned"),
  includeAudible: document.getElementById("includeAudible"),
  parkingMode: document.getElementById("parkingMode"),
  autoAiGroupSchedule: document.getElementById("autoAiGroupSchedule"),
  status: document.getElementById("status")
};

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
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

function renderThreshold() {
  els.similarityThresholdValue.textContent = Number(els.similarityThreshold.value).toFixed(2);
}

function renderSettings(settings) {
  els.aiGroupingEnabled.checked = Boolean(settings.aiGroupingEnabled);
  els.similarityThreshold.value = settings.similarityThreshold ?? 0.82;
  els.includeSnippet.checked = Boolean(settings.includeSnippet);
  els.openaiApiKey.value = settings.openaiApiKey || "";
  els.embeddingsModel.value = settings.embeddingsModel || "text-embedding-3-small";
  els.aiLabeling.checked = Boolean(settings.aiLabeling);
  els.excludedDomains.value = (settings.excludedDomains || []).join("\n");
  els.includePinned.checked = Boolean(settings.includePinned);
  els.includeAudible.checked = Boolean(settings.includeAudible);
  els.parkingMode.value = settings.parkingMode || "append";
  els.autoAiGroupSchedule.value = settings.autoAiGroupSchedule || "off";
  renderThreshold();
}

function collectSettings() {
  return {
    aiGroupingEnabled: els.aiGroupingEnabled.checked,
    similarityThreshold: Number(els.similarityThreshold.value),
    includeSnippet: els.includeSnippet.checked,
    openaiApiKey: els.openaiApiKey.value.trim(),
    embeddingsModel: els.embeddingsModel.value,
    aiLabeling: els.aiLabeling.checked,
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
  try {
    const settings = collectSettings();
    const response = await sendMessage("SAVE_SETTINGS", { settings });
    renderSettings(response.settings);
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

els.similarityThreshold.addEventListener("input", renderThreshold);
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
