const statusEl = document.getElementById("status");
const sessionsSelect = document.getElementById("sessionsSelect");
const restoreTarget = document.getElementById("restoreTarget");
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

function formatSessionLabel(session) {
  const created = session.createdAt ? new Date(session.createdAt).toLocaleString() : "Unknown date";
  const count = Array.isArray(session.tabs) ? session.tabs.length : 0;
  return `${session.name} • ${count} tabs • ${created}`;
}

async function loadSessions() {
  const { sessions } = await sendMessage("GET_SESSIONS");

  sessionsSelect.innerHTML = "";
  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = formatSessionLabel(session);
    sessionsSelect.appendChild(option);
  }

  const hasSessions = sessions.length > 0;
  restoreBtn.disabled = !hasSessions;
  sessionsSelect.disabled = !hasSessions;

  if (!hasSessions) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No saved sessions";
    sessionsSelect.appendChild(option);
    setStatus("No saved sessions found.");
  }
}

async function loadSettings() {
  const { settings } = await sendMessage("GET_SETTINGS");
  restoreTarget.value = settings.defaultRestoreTarget || "new";
}

async function onGroupByDomain() {
  try {
    setStatus("Grouping tabs...");
    const result = await sendMessage("GROUP_BY_DOMAIN");
    setStatus(
      `Grouped ${result.tabsGrouped} tab(s) across ${result.domainsGrouped} domain group(s).`,
      "success"
    );
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onParkTabs() {
  try {
    setStatus("Parking tabs...");
    const result = await sendMessage("PARK_TABS");
    if (result.parkedCount === 0) {
      setStatus("No tabs met parking criteria.");
      return;
    }

    setStatus(`Parked ${result.parkedCount} tab(s) to ${result.sessionName}.`, "success");
    await loadSessions();
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onRestoreSession() {
  const sessionId = sessionsSelect.value;
  if (!sessionId) {
    setStatus("Choose a session to restore.", "error");
    return;
  }

  try {
    setStatus("Restoring tabs...");
    const result = await sendMessage("RESTORE_SESSION", {
      sessionId,
      target: restoreTarget.value
    });
    setStatus(`Restored ${result.restoredCount} tab(s) from ${result.sessionName}.`, "success");
  } catch (err) {
    setStatus(err.message, "error");
  }
}

async function onCloseDuplicates() {
  try {
    setStatus("Scanning duplicates...");
    const result = await sendMessage("CLOSE_DUPLICATES");
    setStatus(
      `Closed ${result.closedCount} duplicate tab(s) across ${result.duplicateSets} duplicate URL set(s).`,
      "success"
    );
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function onOpenOptions() {
  chrome.runtime.openOptionsPage();
}

document.getElementById("groupByDomainBtn").addEventListener("click", onGroupByDomain);
document.getElementById("parkTabsBtn").addEventListener("click", onParkTabs);
document.getElementById("restoreBtn").addEventListener("click", onRestoreSession);
document.getElementById("closeDuplicatesBtn").addEventListener("click", onCloseDuplicates);
document.getElementById("openOptionsBtn").addEventListener("click", onOpenOptions);

(async () => {
  try {
    await Promise.all([loadSessions(), loadSettings()]);
  } catch (err) {
    setStatus(err.message, "error");
  }
})();
