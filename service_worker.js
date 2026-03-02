const SETTINGS_KEY = "settings";
const SESSIONS_KEY = "sessions";
const OFFSCREEN_URL = "offscreen.html";
const AUTO_AI_GROUP_ALARM = "smart-tab-tidy-auto-ai-group";
const MAX_SESSIONS = 100;

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const TRACKING_PARAM_EXACT = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"]);
const OPTIONAL_SNIPPET_ORIGINS = ["http://*/*", "https://*/*"];

const DEFAULT_SETTINGS = {
  excludedDomains: [],
  includePinned: false,
  includeAudible: false,
  parkingMode: "append",
  defaultRestoreTarget: "new",
  aiGroupingEnabled: true,
  similarityThreshold: 0.82,
  includeSnippet: false,
  openaiApiKey: "",
  embeddingsModel: "text-embedding-3-small",
  aiLabeling: false,
  autoAiGroupSchedule: "off"
};

let offscreenCreationPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((err) => console.error("Initialize on install failed:", err));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((err) => console.error("Initialize on startup failed:", err));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_AI_GROUP_ALARM) {
    return;
  }

  aiGroupSimilarTabs({ source: "alarm" }).catch((err) => {
    console.error("Auto AI group failed:", err);
  });
});

chrome.commands.onCommand.addListener((command) => {
  const handlers = {
    "ai-group-similar-tabs": () => aiGroupSimilarTabs({ source: "command" }),
    "group-by-domain": () => groupByDomain(),
    "park-tabs": () => parkTabs(),
    "close-duplicates": () => closeDuplicates()
  };

  const handler = handlers[command];
  if (!handler) {
    return;
  }

  handler().catch((err) => {
    console.error(`Command failed (${command}):`, err);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "EMBED_AND_CLUSTER") {
    // Offscreen document handles this message type.
    return false;
  }

  (async () => {
    switch (message?.type) {
      case "GROUP_BY_DOMAIN":
        sendResponse({ ok: true, result: await groupByDomain() });
        return;
      case "PARK_TABS":
        sendResponse({ ok: true, result: await parkTabs() });
        return;
      case "RESTORE_SESSION":
        sendResponse({ ok: true, result: await restoreSession(message.sessionId, message.target) });
        return;
      case "CLOSE_DUPLICATES":
        sendResponse({ ok: true, result: await closeDuplicates() });
        return;
      case "AI_GROUP_OPENAI":
        sendResponse({ ok: true, result: await aiGroupSimilarTabs({ source: "popup" }) });
        return;
      case "GET_SETTINGS":
        sendResponse({ ok: true, result: { settings: await loadSettings() } });
        return;
      case "SAVE_SETTINGS":
        sendResponse({ ok: true, result: { settings: await saveSettings(message.settings || {}) } });
        return;
      case "GET_SESSIONS":
        sendResponse({ ok: true, result: { sessions: await loadSessions() } });
        return;
      case "CLEAR_SESSIONS":
        sendResponse({ ok: true, result: await clearSessions() });
        return;
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: toErrorMessage(err) });
  });

  return true;
});

function toErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeDomainEntry(input) {
  const raw = cleanText(input).toLowerCase();
  if (!raw) {
    return "";
  }

  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0]
    .trim();
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (_err) {
    return null;
  }
}

function getDomain(url) {
  const parsed = parseUrl(url);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

function isProcessableTabUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && ["http:", "https:"].includes(parsed.protocol));
}

function isRestorableUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && ["http:", "https:", "file:"].includes(parsed.protocol));
}

function isExcludedDomain(domain, excludedDomains) {
  if (!domain || !excludedDomains.length) {
    return false;
  }

  return excludedDomains.some((excluded) => domain === excluded || domain.endsWith(`.${excluded}`));
}

function clampThreshold(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(0.5, Math.min(0.98, num));
}

function sanitizeSettings(rawSettings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(rawSettings || {}) };

  const excludedDomains = Array.isArray(merged.excludedDomains)
    ? merged.excludedDomains.map(normalizeDomainEntry).filter(Boolean)
    : [];

  const parkingMode = ["append", "replace"].includes(merged.parkingMode)
    ? merged.parkingMode
    : DEFAULT_SETTINGS.parkingMode;

  const defaultRestoreTarget = ["new", "current"].includes(merged.defaultRestoreTarget)
    ? merged.defaultRestoreTarget
    : DEFAULT_SETTINGS.defaultRestoreTarget;

  const embeddingsModel = ["text-embedding-3-small", "text-embedding-3-large"].includes(merged.embeddingsModel)
    ? merged.embeddingsModel
    : DEFAULT_SETTINGS.embeddingsModel;

  const autoAiGroupSchedule = ["off", "30m", "2h", "daily"].includes(merged.autoAiGroupSchedule)
    ? merged.autoAiGroupSchedule
    : DEFAULT_SETTINGS.autoAiGroupSchedule;

  return {
    excludedDomains: [...new Set(excludedDomains)],
    includePinned: Boolean(merged.includePinned),
    includeAudible: Boolean(merged.includeAudible),
    parkingMode,
    defaultRestoreTarget,
    aiGroupingEnabled: Boolean(merged.aiGroupingEnabled),
    similarityThreshold: clampThreshold(merged.similarityThreshold, DEFAULT_SETTINGS.similarityThreshold),
    includeSnippet: Boolean(merged.includeSnippet),
    openaiApiKey: cleanText(merged.openaiApiKey || ""),
    embeddingsModel,
    aiLabeling: Boolean(merged.aiLabeling),
    autoAiGroupSchedule
  };
}

function hashColor(input) {
  let hash = 0;
  const str = String(input || "");
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

function normalizeUrlForDuplicates(url) {
  const parsed = parseUrl(url);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAM_EXACT.has(lower)) {
      parsed.searchParams.delete(key);
    }
  }

  parsed.searchParams.sort();
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  const query = parsed.searchParams.toString();
  return `${parsed.origin}${path}${query ? `?${query}` : ""}`;
}

function extractUrlWords(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return "";
  }

  const pathAndQuery = `${parsed.pathname || ""} ${parsed.search || ""}`;
  return pathAndQuery
    .replace(/[/?&=_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scheduleToMinutes(schedule) {
  switch (schedule) {
    case "30m":
      return 30;
    case "2h":
      return 120;
    case "daily":
      return 1440;
    default:
      return null;
  }
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs);
    });
  });
}

function tabsRemove(tabIds) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabIds, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function tabsCreate(props) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(props, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsGroup(groupOptions) {
  return new Promise((resolve, reject) => {
    chrome.tabs.group(groupOptions, (groupId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(groupId);
    });
  });
}

function tabGroupsUpdate(groupId, updateProps) {
  return new Promise((resolve, reject) => {
    chrome.tabGroups.update(groupId, updateProps, (group) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(group);
    });
  });
}

function windowsCreate(props) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(props, (windowObj) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(windowObj);
    });
  });
}

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files }, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(results || []);
    });
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function permissionsContains(origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions.contains({ origins }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Boolean(result));
    });
  });
}

function permissionsRequest(origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins }, (granted) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

async function loadSettings() {
  const data = await storageGet(SETTINGS_KEY);
  return sanitizeSettings(data[SETTINGS_KEY]);
}

async function saveSettings(rawSettings) {
  const settings = sanitizeSettings(rawSettings);
  await storageSet({ [SETTINGS_KEY]: settings });
  await syncAutoAiAlarm(settings);
  return settings;
}

async function loadSessions() {
  const data = await storageGet(SESSIONS_KEY);
  return Array.isArray(data[SESSIONS_KEY]) ? data[SESSIONS_KEY] : [];
}

async function saveSessions(sessions) {
  await storageSet({ [SESSIONS_KEY]: sessions.slice(0, MAX_SESSIONS) });
}

async function syncAutoAiAlarm(settings) {
  await new Promise((resolve) => chrome.alarms.clear(AUTO_AI_GROUP_ALARM, () => resolve()));

  const minutes = scheduleToMinutes(settings.autoAiGroupSchedule);
  if (!minutes) {
    return;
  }

  chrome.alarms.create(AUTO_AI_GROUP_ALARM, {
    delayInMinutes: minutes,
    periodInMinutes: minutes
  });
}

async function initialize() {
  const settings = await loadSettings();
  await storageSet({ [SETTINGS_KEY]: settings });

  const sessions = await loadSessions();
  await storageSet({ [SESSIONS_KEY]: Array.isArray(sessions) ? sessions : [] });

  await syncAutoAiAlarm(settings);
}

async function groupByDomain() {
  const settings = await loadSettings();
  const tabs = await tabsQuery({ currentWindow: true });

  const byDomain = new Map();

  for (const tab of tabs) {
    if (!tab.id || !tab.url) {
      continue;
    }
    if (!settings.includePinned && tab.pinned) {
      continue;
    }
    if (!isProcessableTabUrl(tab.url)) {
      continue;
    }

    const domain = getDomain(tab.url);
    if (!domain || isExcludedDomain(domain, settings.excludedDomains)) {
      continue;
    }

    if (!byDomain.has(domain)) {
      byDomain.set(domain, []);
    }
    byDomain.get(domain).push(tab.id);
  }

  const domains = [...byDomain.keys()].sort();
  let tabsGrouped = 0;

  for (const domain of domains) {
    const tabIds = byDomain.get(domain);
    if (!tabIds || !tabIds.length) {
      continue;
    }

    const groupId = await tabsGroup({ tabIds });
    await tabGroupsUpdate(groupId, {
      title: domain,
      color: hashColor(domain),
      collapsed: false
    });

    tabsGrouped += tabIds.length;
  }

  return {
    domainsGrouped: domains.length,
    tabsGrouped
  };
}

function generateSessionId(parkingMode) {
  if (parkingMode === "replace") {
    return "parking-lot";
  }

  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `session-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function makeParkingName(parkingMode) {
  if (parkingMode === "replace") {
    return "Parking Lot";
  }

  return `Parking Lot (${new Date().toLocaleString()})`;
}

async function parkTabs() {
  const settings = await loadSettings();
  const tabs = await tabsQuery({ currentWindow: true });

  const candidates = tabs.filter((tab) => {
    if (!tab.id || !tab.url || tab.active) {
      return false;
    }
    if (!settings.includePinned && tab.pinned) {
      return false;
    }
    if (!settings.includeAudible && tab.audible) {
      return false;
    }
    return isRestorableUrl(tab.url);
  });

  if (!candidates.length) {
    return { parkedCount: 0, sessionName: null, sessionId: null };
  }

  const session = {
    id: generateSessionId(settings.parkingMode),
    name: makeParkingName(settings.parkingMode),
    createdAt: new Date().toISOString(),
    windowId: candidates[0].windowId ?? null,
    tabs: candidates.map((tab) => ({
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || ""
    }))
  };

  const existing = await loadSessions();
  const next = settings.parkingMode === "replace"
    ? [session, ...existing.filter((s) => s.id !== "parking-lot")]
    : [session, ...existing];

  await saveSessions(next);
  await tabsRemove(candidates.map((tab) => tab.id));

  return {
    parkedCount: candidates.length,
    sessionName: session.name,
    sessionId: session.id
  };
}

async function restoreSession(sessionId, target = "new") {
  const sessions = await loadSessions();
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("Selected session was not found.");
  }

  const urls = (session.tabs || []).map((t) => t.url).filter(isRestorableUrl);
  if (!urls.length) {
    throw new Error("Session has no restorable tab URLs.");
  }

  if (target === "new") {
    const createdWindow = await windowsCreate({ url: urls[0] });
    const windowId = createdWindow.id;
    for (let i = 1; i < urls.length; i += 1) {
      await tabsCreate({ windowId, url: urls[i], active: false });
    }
  } else {
    const currentTabs = await tabsQuery({ currentWindow: true });
    const windowId = currentTabs[0]?.windowId;
    if (!windowId) {
      throw new Error("Could not identify current window.");
    }

    for (const url of urls) {
      await tabsCreate({ windowId, url, active: false });
    }
  }

  return {
    restoredCount: urls.length,
    sessionName: session.name
  };
}

async function closeDuplicates() {
  const tabs = await tabsQuery({ currentWindow: true });
  const groups = new Map();

  for (const tab of tabs) {
    if (!tab.id || !tab.url) {
      continue;
    }

    const normalized = normalizeUrlForDuplicates(tab.url);
    if (!normalized) {
      continue;
    }

    if (!groups.has(normalized)) {
      groups.set(normalized, []);
    }
    groups.get(normalized).push(tab);
  }

  let duplicateSets = 0;
  const closeIds = [];

  for (const same of groups.values()) {
    if (same.length < 2) {
      continue;
    }

    duplicateSets += 1;

    const active = same.find((t) => t.active);
    const keeper = active || same.slice().sort((a, b) => {
      const ai = typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
      const bi = typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    })[0];

    for (const t of same) {
      if (t.id !== keeper.id) {
        closeIds.push(t.id);
      }
    }
  }

  if (closeIds.length) {
    await tabsRemove(closeIds);
  }

  return {
    closedCount: closeIds.length,
    duplicateSets
  };
}

async function clearSessions() {
  await saveSessions([]);
  return { cleared: true };
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (offscreenCreationPromise) {
    await offscreenCreationPromise;
    return;
  }

  offscreenCreationPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Run embedding requests and clustering without blocking service worker lifecycle."
  });

  try {
    await offscreenCreationPromise;
  } catch (err) {
    const message = toErrorMessage(err);
    if (!message.includes("Only a single offscreen document")) {
      throw err;
    }
  } finally {
    offscreenCreationPromise = null;
  }
}

function withTimeout(promise, ms, fallback) {
  let timerId;
  const timer = new Promise((resolve) => {
    timerId = setTimeout(() => resolve(fallback), ms);
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timerId));
}

async function canUseSnippets() {
  const hasOrigins = await permissionsContains(OPTIONAL_SNIPPET_ORIGINS);
  if (hasOrigins) {
    return true;
  }

  // Request optional site permission only when snippet mode is explicitly enabled by the user.
  return permissionsRequest(OPTIONAL_SNIPPET_ORIGINS);
}

async function extractSnippet(tabId) {
  try {
    const existing = await withTimeout(tabsSendMessage(tabId, { type: "GET_SNIPPET" }), 700, null);
    if (existing?.ok && existing.snippet) {
      return cleanText(existing.snippet).slice(0, 800);
    }
  } catch (_err) {
    // Content script is likely not injected yet.
  }

  try {
    await executeScript(tabId, ["content_script.js"]);
  } catch (_err) {
    return "";
  }

  const response = await withTimeout(tabsSendMessage(tabId, { type: "GET_SNIPPET" }), 1200, null);
  if (!response?.ok || !response.snippet) {
    return "";
  }

  return cleanText(response.snippet).slice(0, 800);
}

async function buildDocuments(tabs, settings) {
  const warnings = [];
  const snippets = [];

  if (settings.includeSnippet) {
    const snippetAllowed = await canUseSnippets();
    if (!snippetAllowed) {
      warnings.push("Snippet permission denied. Continuing without snippets.");
    }

    for (const tab of tabs) {
      if (!snippetAllowed) {
        snippets.push("");
        continue;
      }

      const snippet = await extractSnippet(tab.id);
      snippets.push(snippet);
      if (!snippet) {
        warnings.push(`No snippet for: ${(tab.title || "Untitled").slice(0, 40)}`);
      }
    }
  } else {
    for (let i = 0; i < tabs.length; i += 1) {
      snippets.push("");
    }
  }

  const docs = [];
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const domain = getDomain(tab.url) || "";
    const title = cleanText(tab.title || "Untitled tab");
    const urlWords = extractUrlWords(tab.url);
    const snippet = cleanText(snippets[i] || "").slice(0, 800);

    const text = cleanText(`${title}\n${domain}\n${urlWords}\n${snippet}`);
    if (!text) {
      continue;
    }

    docs.push({
      tabId: tab.id,
      title,
      domain,
      text
    });
  }

  return { docs, warnings };
}

async function aiGroupSimilarTabs({ source = "popup" } = {}) {
  const settings = await loadSettings();

  if (!settings.aiGroupingEnabled) {
    throw new Error("AI grouping is disabled in Options.");
  }

  if (!settings.openaiApiKey) {
    throw new Error("OpenAI API key is missing. Add it in Options.");
  }

  const tabs = await tabsQuery({ currentWindow: true });
  const candidates = tabs
    .filter((tab) => tab.id && tab.url)
    .filter((tab) => (settings.includePinned ? true : !tab.pinned))
    .filter((tab) => !tab.discarded)
    .filter((tab) => isProcessableTabUrl(tab.url))
    .filter((tab) => !isExcludedDomain(getDomain(tab.url), settings.excludedDomains));

  if (source === "alarm") {
    const activeTabs = await tabsQuery({ active: true, lastFocusedWindow: true });
    const activeDomain = activeTabs[0]?.url ? getDomain(activeTabs[0].url) : null;
    if (activeDomain && isExcludedDomain(activeDomain, settings.excludedDomains)) {
      return {
        groupsCreated: 0,
        tabsGrouped: 0,
        skipped: candidates.length,
        warnings: ["Skipped scheduled run: active domain is excluded."],
        errors: []
      };
    }
  }

  if (candidates.length < 2) {
    return {
      groupsCreated: 0,
      tabsGrouped: 0,
      skipped: candidates.length,
      warnings: ["Not enough eligible tabs."],
      errors: []
    };
  }

  const { docs, warnings: docWarnings } = await buildDocuments(candidates, settings);
  if (docs.length < 2) {
    return {
      groupsCreated: 0,
      tabsGrouped: 0,
      skipped: candidates.length,
      warnings: ["Could not build enough tab documents.", ...docWarnings],
      errors: []
    };
  }

  await ensureOffscreenDocument();
  const offscreenResponse = await runtimeSendMessage({
    type: "EMBED_AND_CLUSTER",
    payload: {
      docs,
      threshold: settings.similarityThreshold,
      model: settings.embeddingsModel,
      apiKey: settings.openaiApiKey,
      aiLabeling: settings.aiLabeling
    }
  });

  if (!offscreenResponse?.ok) {
    throw new Error(offscreenResponse?.error || "Offscreen clustering failed.");
  }

  const clusters = Array.isArray(offscreenResponse.result?.clusters) ? offscreenResponse.result.clusters : [];
  const warnings = [...docWarnings, ...(offscreenResponse.result?.warnings || [])];
  const errors = [...(offscreenResponse.result?.errors || [])];

  const tabIndexById = new Map(candidates.map((tab) => [tab.id, tab.index ?? 99999]));

  const sortedClusters = clusters
    .map((cluster) => ({
      tabIds: [...new Set(Array.isArray(cluster.tabIds) ? cluster.tabIds : [])].filter((id) => tabIndexById.has(id)),
      label: cleanText(cluster.label || "Similar Tabs").slice(0, 60) || "Similar Tabs"
    }))
    .filter((cluster) => cluster.tabIds.length > 0)
    .sort((a, b) => {
      const minA = Math.min(...a.tabIds.map((id) => tabIndexById.get(id) ?? 99999));
      const minB = Math.min(...b.tabIds.map((id) => tabIndexById.get(id) ?? 99999));
      return minA - minB;
    });

  let groupsCreated = 0;
  let tabsGrouped = 0;
  let skipped = 0;

  for (const cluster of sortedClusters) {
    if (cluster.tabIds.length < 2) {
      skipped += 1;
      continue;
    }

    try {
      const groupId = await tabsGroup({ tabIds: cluster.tabIds });
      await tabGroupsUpdate(groupId, {
        title: cluster.label,
        color: hashColor(cluster.label),
        collapsed: false
      });
      groupsCreated += 1;
      tabsGrouped += cluster.tabIds.length;
    } catch (err) {
      errors.push(`Failed to group '${cluster.label}': ${toErrorMessage(err)}`);
    }
  }

  return {
    groupsCreated,
    tabsGrouped,
    skipped,
    warnings,
    errors
  };
}
