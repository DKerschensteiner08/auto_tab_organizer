const SETTINGS_KEY = "settings";
const SESSIONS_KEY = "sessions";
const AUTO_AI_GROUP_ALARM = "smart-tab-tidy-ai-group-schedule";
const OFFSCREEN_PATH = "offscreen.html";
const MAX_SESSIONS = 100;

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const TRACKING_PARAM_EXACT = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"]);

const DEFAULT_SETTINGS = {
  excludedDomains: [],
  includePinned: false,
  includeAudible: false,
  parkingMode: "append",
  defaultRestoreTarget: "new",
  similarityMode: "local",
  includeSnippet: false,
  aiLabeling: false,
  localThreshold: 0.35,
  embeddingsThreshold: 0.82,
  embeddingsEndpoint: "",
  embeddingsApiKey: "",
  autoAiGroupSchedule: "off"
};

let offscreenCreationPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((err) => {
    console.error("Initialization failed on install:", err);
  });
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((err) => {
    console.error("Initialization failed on startup:", err);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_AI_GROUP_ALARM) {
    return;
  }

  aiGroupSimilarTabs({ source: "alarm" }).catch((err) => {
    console.error("Scheduled AI grouping failed:", err);
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
  if (message?.action === "OFFSCREEN_CLUSTER") {
    // Offscreen document handles this action.
    return false;
  }

  (async () => {
    switch (message?.action) {
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
      case "AI_GROUP":
        sendResponse({ ok: true, result: await aiGroupSimilarTabs({ source: "popup" }) });
        return;
      case "GET_SESSIONS":
        sendResponse({ ok: true, result: { sessions: await loadSessions() } });
        return;
      case "GET_SETTINGS":
        sendResponse({ ok: true, result: { settings: await loadSettings() } });
        return;
      case "SAVE_SETTINGS":
        sendResponse({ ok: true, result: { settings: await saveSettings(message.settings || {}) } });
        return;
      case "CLEAR_SESSIONS":
        sendResponse({ ok: true, result: await clearSavedSessions() });
        return;
      default:
        sendResponse({ ok: false, error: "Unknown action." });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: toErrorMessage(err) });
  });

  return true;
});

function toErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
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

function alarmsClear(name) {
  return new Promise((resolve, reject) => {
    chrome.alarms.clear(name, (cleared) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(cleared);
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

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files }, (injectionResults) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(injectionResults || []);
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

function normalizeDomainEntry(input) {
  const raw = String(input || "").trim().toLowerCase();
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

function clampThreshold(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(0.99, Math.max(0.05, number));
}

function sanitizeSettings(rawSettings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(rawSettings || {}) };

  const excludedDomains = Array.isArray(merged.excludedDomains)
    ? merged.excludedDomains.map(normalizeDomainEntry).filter(Boolean)
    : [];

  const similarityMode = ["local", "embeddings"].includes(merged.similarityMode)
    ? merged.similarityMode
    : DEFAULT_SETTINGS.similarityMode;

  const parkingMode = ["append", "replace"].includes(merged.parkingMode)
    ? merged.parkingMode
    : DEFAULT_SETTINGS.parkingMode;

  const defaultRestoreTarget = ["new", "current"].includes(merged.defaultRestoreTarget)
    ? merged.defaultRestoreTarget
    : DEFAULT_SETTINGS.defaultRestoreTarget;

  const autoAiGroupSchedule = ["off", "30m", "2h", "daily"].includes(merged.autoAiGroupSchedule)
    ? merged.autoAiGroupSchedule
    : DEFAULT_SETTINGS.autoAiGroupSchedule;

  const embeddingsEndpoint = String(merged.embeddingsEndpoint || "").trim();

  return {
    excludedDomains: [...new Set(excludedDomains)],
    includePinned: Boolean(merged.includePinned),
    includeAudible: Boolean(merged.includeAudible),
    parkingMode,
    defaultRestoreTarget,
    similarityMode,
    includeSnippet: Boolean(merged.includeSnippet),
    aiLabeling: Boolean(merged.aiLabeling),
    localThreshold: clampThreshold(merged.localThreshold, DEFAULT_SETTINGS.localThreshold),
    embeddingsThreshold: clampThreshold(merged.embeddingsThreshold, DEFAULT_SETTINGS.embeddingsThreshold),
    embeddingsEndpoint,
    embeddingsApiKey: String(merged.embeddingsApiKey || ""),
    autoAiGroupSchedule
  };
}

async function loadSettings() {
  const result = await storageGet(SETTINGS_KEY);
  return sanitizeSettings(result[SETTINGS_KEY]);
}

async function saveSettings(rawSettings) {
  const settings = sanitizeSettings(rawSettings);
  if (settings.similarityMode === "embeddings" && settings.embeddingsEndpoint) {
    ensureValidEndpoint(settings.embeddingsEndpoint);
  }

  await storageSet({ [SETTINGS_KEY]: settings });
  await syncAutoGroupAlarm(settings);
  return settings;
}

async function loadSessions() {
  const result = await storageGet(SESSIONS_KEY);
  return Array.isArray(result[SESSIONS_KEY]) ? result[SESSIONS_KEY] : [];
}

async function saveSessions(sessions) {
  await storageSet({ [SESSIONS_KEY]: sessions.slice(0, MAX_SESSIONS) });
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

async function syncAutoGroupAlarm(settings) {
  await alarmsClear(AUTO_AI_GROUP_ALARM);
  const minutes = scheduleToMinutes(settings.autoAiGroupSchedule);
  if (!minutes) {
    return;
  }

  chrome.alarms.create(AUTO_AI_GROUP_ALARM, {
    delayInMinutes: minutes,
    periodInMinutes: minutes
  });
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (_err) {
    return null;
  }
}

function isProcessableTabUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }

  const protocol = parsed.protocol;
  return protocol === "http:" || protocol === "https:";
}

function isRestorableUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }

  return ["http:", "https:", "file:"].includes(parsed.protocol);
}

function getDomain(url) {
  const parsed = parseUrl(url);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isExcludedDomain(domain, excludedDomains) {
  if (!domain || !excludedDomains.length) {
    return false;
  }

  return excludedDomains.some((excluded) => domain === excluded || domain.endsWith(`.${excluded}`));
}

function hashColor(input) {
  let hash = 0;
  const value = String(input || "");
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
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
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  const query = parsed.searchParams.toString();
  return `${parsed.origin}${pathname}${query ? `?${query}` : ""}`;
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

function getParkingName(parkingMode) {
  if (parkingMode === "replace") {
    return "Parking Lot";
  }
  return `Parking Lot (${new Date().toLocaleString()})`;
}

function ensureValidEndpoint(endpoint) {
  const parsed = parseUrl(endpoint);
  if (!parsed) {
    throw new Error("Embeddings endpoint must be a valid URL.");
  }

  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error("Embeddings endpoint must be https:// unless using localhost.");
  }
}

async function initialize() {
  const settings = await loadSettings();
  await storageSet({ [SETTINGS_KEY]: settings });

  const sessions = await loadSessions();
  await storageSet({ [SESSIONS_KEY]: Array.isArray(sessions) ? sessions : [] });

  await syncAutoGroupAlarm(settings);
}

async function groupByDomain() {
  const settings = await loadSettings();
  const tabs = await tabsQuery({ currentWindow: true });

  const groupsByDomain = new Map();

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

    if (!groupsByDomain.has(domain)) {
      groupsByDomain.set(domain, []);
    }
    groupsByDomain.get(domain).push(tab.id);
  }

  const domains = [...groupsByDomain.keys()].sort();
  let tabsGrouped = 0;

  for (const domain of domains) {
    const ids = groupsByDomain.get(domain);
    if (!ids || !ids.length) {
      continue;
    }

    const groupId = await tabsGroup({ tabIds: ids });
    await tabGroupsUpdate(groupId, {
      title: domain,
      color: hashColor(domain),
      collapsed: false
    });

    tabsGrouped += ids.length;
  }

  return {
    domainsGrouped: domains.length,
    tabsGrouped
  };
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
    return { parkedCount: 0, sessionId: null, sessionName: null };
  }

  const session = {
    id: generateSessionId(settings.parkingMode),
    name: getParkingName(settings.parkingMode),
    createdAt: new Date().toISOString(),
    windowId: candidates[0].windowId ?? null,
    tabs: candidates.map((tab) => ({
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || ""
    }))
  };

  const existing = await loadSessions();
  const nextSessions = settings.parkingMode === "replace"
    ? [session, ...existing.filter((s) => s.id !== "parking-lot")]
    : [session, ...existing];

  await saveSessions(nextSessions);
  await tabsRemove(candidates.map((tab) => tab.id));

  return {
    parkedCount: candidates.length,
    sessionId: session.id,
    sessionName: session.name
  };
}

async function restoreSession(sessionId, target = "new") {
  const sessions = await loadSessions();
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("Selected session was not found.");
  }

  const urls = (session.tabs || []).map((tab) => tab.url).filter(isRestorableUrl);
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

  for (const sameUrlTabs of groups.values()) {
    if (sameUrlTabs.length < 2) {
      continue;
    }

    duplicateSets += 1;

    const active = sameUrlTabs.find((tab) => tab.active);
    const keeper = active || sameUrlTabs.slice().sort((a, b) => {
      const ai = typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
      const bi = typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    })[0];

    for (const tab of sameUrlTabs) {
      if (tab.id !== keeper.id) {
        closeIds.push(tab.id);
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

async function clearSavedSessions() {
  await saveSessions([]);
  return { cleared: true };
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
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
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Compute semantic clustering and call embeddings endpoint."
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

async function closeOffscreenDocument() {
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_err) {
    // No-op: if close fails, extension can still proceed.
  }
}

function withTimeout(promise, ms, fallbackValue) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function extractSnippetForTab(tabId) {
  try {
    const directResponse = await withTimeout(
      tabsSendMessage(tabId, { action: "GET_SNIPPET" }),
      700,
      { ok: false, snippet: "" }
    );
    if (directResponse?.ok && directResponse.snippet) {
      return normalizeText(directResponse.snippet).slice(0, 800);
    }
  } catch (_err) {
    // Inject content script if not already present.
  }

  try {
    await executeScript(tabId, ["content_script.js"]);
  } catch (_err) {
    return "";
  }

  const response = await withTimeout(tabsSendMessage(tabId, { action: "GET_SNIPPET" }), 1200, {
    ok: false,
    snippet: ""
  });

  if (!response?.ok || !response.snippet) {
    return "";
  }

  return normalizeText(response.snippet).slice(0, 800);
}

async function buildAiDocuments(tabs, settings) {
  const warnings = [];
  const documents = [];

  const snippetPromises = settings.includeSnippet
    ? tabs.map((tab) => extractSnippetForTab(tab.id))
    : tabs.map(() => Promise.resolve(""));

  const snippets = await Promise.all(snippetPromises);

  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const domain = getDomain(tab.url) || "";
    const title = normalizeText(tab.title || "Untitled tab");
    const urlWords = extractUrlWords(tab.url);
    const snippet = settings.includeSnippet ? normalizeText(snippets[i] || "") : "";

    if (settings.includeSnippet && !snippet) {
      warnings.push(`Snippet unavailable for tab: ${title.slice(0, 40)}`);
    }

    const text = normalizeText(`${title}\n${domain}\n${urlWords}\n${snippet}`);
    if (!text) {
      continue;
    }

    documents.push({
      tabId: tab.id,
      title,
      domain,
      text
    });
  }

  return { documents, warnings };
}

async function aiGroupSimilarTabs({ source = "popup" } = {}) {
  const settings = await loadSettings();

  if (settings.similarityMode === "embeddings") {
    if (!settings.embeddingsEndpoint) {
      throw new Error("Embeddings mode is enabled but endpoint URL is empty.");
    }
    ensureValidEndpoint(settings.embeddingsEndpoint);
  }

  if (source === "alarm") {
    const activeTabs = await tabsQuery({ active: true, lastFocusedWindow: true });
    const activeDomain = activeTabs[0]?.url ? getDomain(activeTabs[0].url) : null;
    if (activeDomain && isExcludedDomain(activeDomain, settings.excludedDomains)) {
      return {
        groupsCreated: 0,
        tabsGrouped: 0,
        clustersSkipped: 0,
        warnings: ["Skipped by schedule because active tab domain is excluded."],
        errors: []
      };
    }
  }

  const windowTabs = await tabsQuery({ currentWindow: true });
  const candidates = windowTabs
    .filter((tab) => tab.id && tab.url)
    .filter((tab) => (settings.includePinned ? true : !tab.pinned))
    .filter((tab) => !tab.discarded)
    .filter((tab) => isProcessableTabUrl(tab.url))
    .filter((tab) => {
      const domain = getDomain(tab.url);
      return !isExcludedDomain(domain, settings.excludedDomains);
    });

  if (candidates.length < 2) {
    return {
      groupsCreated: 0,
      tabsGrouped: 0,
      clustersSkipped: candidates.length,
      warnings: ["Not enough candidate tabs for semantic grouping."],
      errors: []
    };
  }

  const { documents, warnings: docWarnings } = await buildAiDocuments(candidates, settings);
  if (documents.length < 2) {
    return {
      groupsCreated: 0,
      tabsGrouped: 0,
      clustersSkipped: candidates.length,
      warnings: ["Could not build enough tab text documents.", ...docWarnings],
      errors: []
    };
  }

  let offscreenResponse;
  await ensureOffscreenDocument();
  try {
    offscreenResponse = await runtimeSendMessage({
      action: "OFFSCREEN_CLUSTER",
      payload: {
        documents,
        settings: {
          similarityMode: settings.similarityMode,
          localThreshold: settings.localThreshold,
          embeddingsThreshold: settings.embeddingsThreshold,
          embeddingsEndpoint: settings.embeddingsEndpoint,
          embeddingsApiKey: settings.embeddingsApiKey,
          aiLabeling: settings.aiLabeling
        }
      }
    });
  } finally {
    await closeOffscreenDocument();
  }

  if (!offscreenResponse?.ok) {
    throw new Error(offscreenResponse?.error || "Offscreen clustering failed.");
  }

  const rawClusters = Array.isArray(offscreenResponse.result?.clusters) ? offscreenResponse.result.clusters : [];
  const offscreenWarnings = Array.isArray(offscreenResponse.result?.warnings) ? offscreenResponse.result.warnings : [];

  const tabInfo = new Map(candidates.map((tab) => [tab.id, tab]));
  const sortedClusters = rawClusters
    .map((cluster) => ({
      tabIds: Array.isArray(cluster.tabIds) ? cluster.tabIds.filter((id) => tabInfo.has(id)) : [],
      label: normalizeText(cluster.label || "Similar Tabs").slice(0, 60)
    }))
    .filter((cluster) => cluster.tabIds.length > 0)
    .sort((a, b) => {
      const minA = Math.min(...a.tabIds.map((id) => tabInfo.get(id)?.index ?? 99999));
      const minB = Math.min(...b.tabIds.map((id) => tabInfo.get(id)?.index ?? 99999));
      return minA - minB;
    });

  let groupsCreated = 0;
  let tabsGrouped = 0;
  let clustersSkipped = 0;
  const errors = [];

  for (const cluster of sortedClusters) {
    const uniqueIds = [...new Set(cluster.tabIds)].filter((id) => tabInfo.has(id));
    if (uniqueIds.length < 2) {
      clustersSkipped += 1;
      continue;
    }

    try {
      const groupId = await tabsGroup({ tabIds: uniqueIds });
      await tabGroupsUpdate(groupId, {
        title: cluster.label || "Similar Tabs",
        color: hashColor(cluster.label || String(uniqueIds[0])),
        collapsed: false
      });
      groupsCreated += 1;
      tabsGrouped += uniqueIds.length;
    } catch (err) {
      errors.push(`Failed to group cluster (${(cluster.label || "unnamed").slice(0, 30)}): ${toErrorMessage(err)}`);
    }
  }

  return {
    groupsCreated,
    tabsGrouped,
    clustersSkipped,
    warnings: [...docWarnings, ...offscreenWarnings],
    errors
  };
}
