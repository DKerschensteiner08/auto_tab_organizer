const statusEl = document.getElementById("status");
const sessionsSelect = document.getElementById("sessionsSelect");
const restoreBtn = document.getElementById("restoreBtn");
const restoreTargetEl = document.getElementById("restoreTarget");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`.trim();
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

function formatSession(session) {
  const created = session.createdAt ? new Date(session.createdAt).toLocaleString() : "Unknown";
  const count = Array.isArray(session.tabs) ? session.tabs.length : 0;
  return `${session.name} • ${count} tabs • ${created}`;
}

function formatAiSummary(result) {
  const lines = [
    `Groups created: ${result.groupsCreated || 0}`,
    `Tabs grouped: ${result.tabsGrouped || 0}`,
    `Skipped clusters: ${result.skipped || 0}`
  ];

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];

  if (warnings.length) {
    lines.push(`Warnings: ${warnings.slice(0, 2).join(" | ")}`);
  }
  if (errors.length) {
    lines.push(`Errors: ${errors.slice(0, 2).join(" | ")}`);
  }

  return lines.join("\n");
}

async function loadSessions() {
  const { sessions } = await sendMessage("GET_SESSIONS");
  sessionsSelect.innerHTML = "";

  if (!sessions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No saved sessions";
    sessionsSelect.appendChild(option);
    sessionsSelect.disabled = true;
    restoreBtn.disabled = true;
    return;
  }

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = formatSession(session);
    sessionsSelect.appendChild(option);
  }

  sessionsSelect.disabled = false;
  restoreBtn.disabled = false;
}

async function loadSettings() {
  const { settings } = await sendMessage("GET_SETTINGS");
  restoreTargetEl.value = settings.defaultRestoreTarget || "new";
}

async function onAiGroup() {
  try {
    setStatus("Grouping similar tabs with OpenAI...");
    const result = await sendMessage("AI_GROUP_OPENAI");
    setStatus(formatAiSummary(result), "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onGroupByDomain() {
  try {
    setStatus("Grouping by domain...");
    const result = await sendMessage("GROUP_BY_DOMAIN");
    setStatus(`Grouped ${result.tabsGrouped} tabs across ${result.domainsGrouped} domain groups.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onParkTabs() {
  try {
    setStatus("Parking tabs...");
    const result = await sendMessage("PARK_TABS");
    if (!result.parkedCount) {
      setStatus("No tabs met parking criteria.");
      return;
    }

    setStatus(`Parked ${result.parkedCount} tabs into ${result.sessionName}.`, "success");
    await loadSessions();
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onRestore() {
  if (!sessionsSelect.value) {
    setStatus("Choose a saved session first.", "error");
    return;
  }

  try {
    setStatus("Restoring session...");
    const result = await sendMessage("RESTORE_SESSION", {
      sessionId: sessionsSelect.value,
      target: restoreTargetEl.value
    });
    setStatus(`Restored ${result.restoredCount} tabs from ${result.sessionName}.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onCloseDuplicates() {
  try {
    setStatus("Closing duplicate tabs...");
    const result = await sendMessage("CLOSE_DUPLICATES");
    setStatus(`Closed ${result.closedCount} tabs from ${result.duplicateSets} duplicate sets.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

document.getElementById("aiGroupBtn").addEventListener("click", onAiGroup);
document.getElementById("groupByDomainBtn").addEventListener("click", onGroupByDomain);
document.getElementById("parkTabsBtn").addEventListener("click", onParkTabs);
document.getElementById("restoreBtn").addEventListener("click", onRestore);
document.getElementById("closeDuplicatesBtn").addEventListener("click", onCloseDuplicates);
document.getElementById("openOptionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

(async () => {
  try {
    await Promise.all([loadSessions(), loadSettings()]);
    setStatus("Ready.");
  } catch (err) {
    setStatus(err.message, "error");
  }
})();
