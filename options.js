const excludedDomainsEl = document.getElementById("excludedDomains");
const includePinnedEl = document.getElementById("includePinned");
const includeAudibleEl = document.getElementById("includeAudible");
const parkingModeEl = document.getElementById("parkingMode");
const autoTidyScheduleEl = document.getElementById("autoTidySchedule");
const statusEl = document.getElementById("status");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
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

function renderSettings(settings) {
  excludedDomainsEl.value = (settings.excludedDomains || []).join("\n");
  includePinnedEl.checked = Boolean(settings.includePinned);
  includeAudibleEl.checked = Boolean(settings.includeAudible);
  parkingModeEl.value = settings.parkingMode || "append";
  autoTidyScheduleEl.value = settings.autoTidySchedule || "off";
}

function collectSettingsFromForm() {
  return {
    excludedDomains: parseExcludedDomains(excludedDomainsEl.value),
    includePinned: includePinnedEl.checked,
    includeAudible: includeAudibleEl.checked,
    parkingMode: parkingModeEl.value,
    autoTidySchedule: autoTidyScheduleEl.value
  };
}

async function loadSettings() {
  const { settings } = await sendMessage("GET_SETTINGS");
  renderSettings(settings);
}

async function saveSettings() {
  const settings = collectSettingsFromForm();
  const result = await sendMessage("SAVE_SETTINGS", { settings });
  renderSettings(result.settings);
}

async function clearSessions() {
  const confirmed = window.confirm("Delete all saved sessions? This cannot be undone.");
  if (!confirmed) {
    return;
  }

  await sendMessage("CLEAR_SESSIONS");
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    await saveSettings();
    setStatus("Settings saved.", "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
});

document.getElementById("clearSessionsBtn").addEventListener("click", async () => {
  try {
    await clearSessions();
    setStatus("Saved sessions cleared.", "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
});

(async () => {
  try {
    await loadSettings();
  } catch (err) {
    setStatus(err.message, "error");
  }
})();
