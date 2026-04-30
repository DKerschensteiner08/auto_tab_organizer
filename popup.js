const els = {
  status: document.getElementById("status"),
  sessionsList: document.getElementById("sessionsList"),
  sessionRow: document.getElementById("sessionRowTemplate"),
  statTabs: document.getElementById("statTabs"),
  statGroups: document.getElementById("statGroups"),
  statDuplicates: document.getElementById("statDuplicates"),
  statDuplicatesCard: document.getElementById("statDuplicatesCard"),
  statSessions: document.getElementById("statSessions"),
  closeDuplicatesLabel: document.getElementById("closeDuplicatesLabel"),
  closeDuplicatesBtn: document.getElementById("closeDuplicatesBtn")
};

function setStatus(message, kind = "") {
  els.status.textContent = message || "";
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

function formatRelativeTime(iso) {
  if (!iso) {
    return "unknown";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "unknown";
  }
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

async function refreshStats() {
  try {
    const stats = await sendMessage("GET_STATS");
    els.statTabs.textContent = stats.tabCount ?? 0;
    els.statGroups.textContent = stats.groupCount ?? 0;
    els.statDuplicates.textContent = stats.duplicateExtras ?? 0;
    els.statSessions.textContent = stats.sessionCount ?? 0;

    const extras = stats.duplicateExtras || 0;
    els.statDuplicatesCard.classList.toggle("alert", extras > 0);
    els.closeDuplicatesLabel.textContent = extras > 0
      ? `Close ${pluralize(extras, "Duplicate")}`
      : "Close Duplicates";
    els.closeDuplicatesBtn.disabled = extras === 0;
  } catch (_err) {
    // Stats failures shouldn't block other actions.
  }
}

function buildSessionRow(session) {
  const node = els.sessionRow.content.firstElementChild.cloneNode(true);
  const nameEl = node.querySelector(".session-name");
  const metaEl = node.querySelector(".session-meta");
  const restoreBtn = node.querySelector(".icon-btn.restore");
  const deleteBtn = node.querySelector(".icon-btn.delete");

  const tabsCount = Array.isArray(session.tabs) ? session.tabs.length : 0;
  nameEl.textContent = session.name || "Saved session";
  metaEl.textContent = `${pluralize(tabsCount, "tab")} • ${formatRelativeTime(session.createdAt)}`;
  nameEl.title = session.createdAt
    ? `${session.name}\nSaved ${new Date(session.createdAt).toLocaleString()}`
    : session.name || "";

  restoreBtn.addEventListener("click", () => onRestore(session));
  deleteBtn.addEventListener("click", () => onDeleteSession(session));

  return node;
}

async function loadSessions() {
  try {
    const { sessions } = await sendMessage("GET_SESSIONS");
    els.sessionsList.innerHTML = "";
    for (const session of sessions) {
      els.sessionsList.appendChild(buildSessionRow(session));
    }
  } catch (err) {
    setStatus(err.message, "error");
  }
}

function formatAiSummary(result) {
  const parts = [];
  if (result.groupsCreated) {
    parts.push(`${pluralize(result.groupsCreated, "group")} created`);
  }
  if (result.tabsGrouped) {
    parts.push(`${result.tabsGrouped} tabs grouped`);
  }
  if (!parts.length) {
    parts.push("No new groups created");
  }
  const warnings = (result.warnings || []).slice(0, 1);
  const errors = (result.errors || []).slice(0, 1);
  if (warnings.length) parts.push(warnings[0]);
  if (errors.length) parts.push(errors[0]);
  return parts.join(" · ");
}

async function refreshAfterAction() {
  await Promise.all([refreshStats(), loadSessions()]);
}

async function withAction(label, fn) {
  try {
    setStatus(label);
    const result = await fn();
    await refreshAfterAction();
    return result;
  } catch (err) {
    setStatus(err.message, "error");
    throw err;
  }
}

async function onAiGroup() {
  try {
    const result = await withAction("Grouping similar tabs with AI…", () => sendMessage("AI_GROUP_OPENAI"));
    setStatus(formatAiSummary(result), result.groupsCreated ? "success" : "");
  } catch (_err) {}
}

async function onGroupByDomain() {
  try {
    const result = await withAction("Grouping by domain…", () => sendMessage("GROUP_BY_DOMAIN"));
    setStatus(`Grouped ${result.tabsGrouped} tabs across ${pluralize(result.domainsGrouped, "domain")}.`, "success");
  } catch (_err) {}
}

async function onSortByDomain() {
  try {
    const result = await withAction("Sorting tabs…", () => sendMessage("SORT_TABS_BY_DOMAIN"));
    setStatus(result.movedCount
      ? `Sorted ${pluralize(result.movedCount, "tab")} by domain.`
      : "Nothing to sort.", result.movedCount ? "success" : "");
  } catch (_err) {}
}

async function onUngroupAll() {
  try {
    const result = await withAction("Ungrouping…", () => sendMessage("UNGROUP_ALL"));
    setStatus(result.ungroupedCount
      ? `Ungrouped ${pluralize(result.ungroupedCount, "tab")}.`
      : "No grouped tabs.", result.ungroupedCount ? "success" : "");
  } catch (_err) {}
}

async function onParkTabs() {
  try {
    const result = await withAction("Parking tabs…", () => sendMessage("PARK_TABS"));
    if (!result.parkedCount) {
      setStatus("No tabs met parking criteria.");
      return;
    }
    setStatus(`Parked ${pluralize(result.parkedCount, "tab")} into "${result.sessionName}".`, "success");
  } catch (_err) {}
}

async function onRestore(session) {
  try {
    const result = await withAction(`Restoring "${session.name}"…`, () => sendMessage("RESTORE_SESSION", {
      sessionId: session.id
    }));
    setStatus(`Restored ${pluralize(result.restoredCount, "tab")}.`, "success");
  } catch (_err) {}
}

async function onDeleteSession(session) {
  if (!confirm(`Delete saved session "${session.name}"?`)) {
    return;
  }
  try {
    await withAction("Deleting session…", () => sendMessage("DELETE_SESSION", { sessionId: session.id }));
    setStatus("Session deleted.", "success");
  } catch (_err) {}
}

async function onCloseDuplicates() {
  try {
    const result = await withAction("Closing duplicates…", () => sendMessage("CLOSE_DUPLICATES"));
    setStatus(result.closedCount
      ? `Closed ${pluralize(result.closedCount, "tab")} from ${pluralize(result.duplicateSets, "duplicate set")}.`
      : "No duplicates found.", result.closedCount ? "success" : "");
  } catch (_err) {}
}

document.getElementById("aiGroupBtn").addEventListener("click", onAiGroup);
document.getElementById("groupByDomainBtn").addEventListener("click", onGroupByDomain);
document.getElementById("sortByDomainBtn").addEventListener("click", onSortByDomain);
document.getElementById("ungroupAllBtn").addEventListener("click", onUngroupAll);
document.getElementById("parkTabsBtn").addEventListener("click", onParkTabs);
document.getElementById("closeDuplicatesBtn").addEventListener("click", onCloseDuplicates);
document.getElementById("openOptionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());

(async () => {
  await refreshAfterAction();
  setStatus("");
})();
