const statusEl = document.getElementById("status");
const sessionsSelect = document.getElementById("sessionsSelect");
const restoreTargetEl = document.getElementById("restoreTarget");
const restoreBtn = document.getElementById("restoreBtn");

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

function formatSessionOption(session) {
  const date = session.createdAt ? new Date(session.createdAt).toLocaleString() : "Unknown";
  const count = Array.isArray(session.tabs) ? session.tabs.length : 0;
  return `${session.name} • ${count} tabs • ${date}`;
}

function formatAiSummary(result) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];

  const lines = [
    `Groups created: ${result.groupsCreated || 0}`,
    `Tabs grouped: ${result.tabsGrouped || 0}`,
    `Clusters skipped: ${result.clustersSkipped || 0}`
  ];

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
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No saved sessions";
    sessionsSelect.appendChild(empty);
    sessionsSelect.disabled = true;
    restoreBtn.disabled = true;
    return;
  }

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = formatSessionOption(session);
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
    setStatus("AI grouping similar tabs...");
    const result = await sendMessage("AI_GROUP");
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

    setStatus(`Parked ${result.parkedCount} tabs to ${result.sessionName}.`, "success");
    await loadSessions();
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onRestore() {
  const sessionId = sessionsSelect.value;
  if (!sessionId) {
    setStatus("Select a saved session first.", "error");
    return;
  }

  try {
    setStatus("Restoring session...");
    const result = await sendMessage("RESTORE_SESSION", {
      sessionId,
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
    setStatus(
      `Closed ${result.closedCount} duplicates across ${result.duplicateSets} duplicate URL sets.`,
      "success"
    );
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
