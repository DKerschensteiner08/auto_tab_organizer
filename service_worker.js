const SETTINGS_KEY = "settings";
const SESSIONS_KEY = "sessions";
const AUTO_TIDY_ALARM = "smart-tab-tidy-auto-group";
const MAX_SESSIONS = 100;

const DEFAULT_SETTINGS = {
  excludedDomains: [],
  includePinned: false,
  includeAudible: false,
  parkingMode: "append",
  defaultRestoreTarget: "new",
  autoTidySchedule: "off"
};

const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
];

const TRACKING_PARAM_EXACT = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid"]);

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

function tabsCreate(createProps) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProps, (tab) => {
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

function windowsCreate(createData) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(createData, (windowObj) => {
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
    chrome.alarms.clear(name, (wasCleared) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(wasCleared);
    });
  });
}

function alarmsCreate(name, alarmInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.alarms.create(name, alarmInfo);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

function normalizeDomainEntry(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }

  const withoutProtocol = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const domain = withoutProtocol.split("/")[0].split(":")[0].trim();
  return domain;
}

function sanitizeSettings(rawSettings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(rawSettings || {}) };

  const excludedDomains = Array.isArray(merged.excludedDomains)
    ? merged.excludedDomains.map(normalizeDomainEntry).filter(Boolean)
    : [];

  const autoTidySchedule = ["off", "30m", "2h", "daily"].includes(merged.autoTidySchedule)
    ? merged.autoTidySchedule
    : DEFAULT_SETTINGS.autoTidySchedule;

  const parkingMode = ["append", "replace"].includes(merged.parkingMode)
    ? merged.parkingMode
    : DEFAULT_SETTINGS.parkingMode;

  const defaultRestoreTarget = ["new", "current"].includes(merged.defaultRestoreTarget)
    ? merged.defaultRestoreTarget
    : DEFAULT_SETTINGS.defaultRestoreTarget;

  return {
    excludedDomains: [...new Set(excludedDomains)],
    includePinned: Boolean(merged.includePinned),
    includeAudible: Boolean(merged.includeAudible),
    parkingMode,
    defaultRestoreTarget,
    autoTidySchedule
  };
}

async function loadSettings() {
  const result = await storageGet(SETTINGS_KEY);
  const settings = sanitizeSettings(result[SETTINGS_KEY]);
  return settings;
}

async function saveSettings(rawSettings) {
  const settings = sanitizeSettings(rawSettings);
  await storageSet({ [SETTINGS_KEY]: settings });
  await syncAutoTidyAlarm(settings);
  return settings;
}

async function loadSessions() {
  const result = await storageGet(SESSIONS_KEY);
  const sessions = Array.isArray(result[SESSIONS_KEY]) ? result[SESSIONS_KEY] : [];
  return sessions;
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

async function syncAutoTidyAlarm(settings) {
  await alarmsClear(AUTO_TIDY_ALARM);
  const periodInMinutes = scheduleToMinutes(settings.autoTidySchedule);
  if (!periodInMinutes) {
    return;
  }

  await alarmsCreate(AUTO_TIDY_ALARM, {
    delayInMinutes: periodInMinutes,
    periodInMinutes
  });
}

function shouldSkipDomainFromUrl(url) {
  try {
    const parsed = new URL(url);
    return !["http:", "https:"].includes(parsed.protocol);
  } catch (_err) {
    return true;
  }
}

function getDomain(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  } catch (_err) {
    return null;
  }
}

function isExcludedDomain(domain, excludedDomains) {
  if (!domain || !excludedDomains.length) {
    return false;
  }

  return excludedDomains.some((excluded) => domain === excluded || domain.endsWith(`.${excluded}`));
}

function hashColor(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i += 1) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

function normalizeUrlForDuplicates(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }

    parsed.hash = "";

    for (const key of [...parsed.searchParams.keys()]) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.startsWith("utm_") || TRACKING_PARAM_EXACT.has(lowerKey)) {
        parsed.searchParams.delete(key);
      }
    }

    parsed.searchParams.sort();
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    const search = parsed.searchParams.toString();

    return `${parsed.origin}${pathname}${search ? `?${search}` : ""}`;
  } catch (_err) {
    return url.split("#")[0];
  }
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

function makeParkingLotName(parkingMode) {
  if (parkingMode === "replace") {
    return "Parking Lot";
  }

  const timestamp = new Date().toLocaleString();
  return `Parking Lot (${timestamp})`;
}

function isRestorableUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return ["http:", "https:", "file:"].includes(parsed.protocol);
  } catch (_err) {
    return false;
  }
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

    if (shouldSkipDomainFromUrl(tab.url)) {
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
  let groupedTabCount = 0;

  for (const domain of domains) {
    const tabIds = groupsByDomain.get(domain);
    if (!tabIds || tabIds.length === 0) {
      continue;
    }

    const groupId = await tabsGroup({ tabIds });
    await tabGroupsUpdate(groupId, {
      title: domain,
      color: hashColor(domain),
      collapsed: false
    });

    groupedTabCount += tabIds.length;
  }

  return {
    domainsGrouped: domains.length,
    tabsGrouped: groupedTabCount
  };
}

async function parkTabs() {
  const settings = await loadSettings();
  const tabs = await tabsQuery({ currentWindow: true });

  const candidateTabs = tabs.filter((tab) => {
    if (!tab.id || !tab.url) {
      return false;
    }
    if (tab.active) {
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

  if (candidateTabs.length === 0) {
    return {
      parkedCount: 0,
      sessionName: null,
      sessionId: null
    };
  }

  const session = {
    id: generateSessionId(settings.parkingMode),
    name: makeParkingLotName(settings.parkingMode),
    createdAt: new Date().toISOString(),
    windowId: candidateTabs[0].windowId ?? null,
    tabs: candidateTabs.map((tab) => ({
      url: tab.url,
      title: tab.title || tab.url,
      favIconUrl: tab.favIconUrl || ""
    }))
  };

  const sessions = await loadSessions();
  const nextSessions = settings.parkingMode === "replace"
    ? [session, ...sessions.filter((s) => s.id !== "parking-lot")]
    : [session, ...sessions];

  await saveSessions(nextSessions);
  await tabsRemove(candidateTabs.map((tab) => tab.id));

  return {
    parkedCount: candidateTabs.length,
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
      throw new Error("Could not identify the current window for restore.");
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
  const byNormalizedUrl = new Map();

  for (const tab of tabs) {
    if (!tab.id || !tab.url) {
      continue;
    }

    const normalized = normalizeUrlForDuplicates(tab.url);
    if (!normalized) {
      continue;
    }

    if (!byNormalizedUrl.has(normalized)) {
      byNormalizedUrl.set(normalized, []);
    }
    byNormalizedUrl.get(normalized).push(tab);
  }

  const idsToClose = [];
  let duplicateSets = 0;

  for (const group of byNormalizedUrl.values()) {
    if (group.length < 2) {
      continue;
    }

    duplicateSets += 1;

    const activeTab = group.find((tab) => tab.active);
    const keeper = activeTab || group.slice().sort((a, b) => {
      const aIndex = typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
      const bIndex = typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
      return aIndex - bIndex;
    })[0];

    for (const tab of group) {
      if (tab.id !== keeper.id) {
        idsToClose.push(tab.id);
      }
    }
  }

  if (idsToClose.length) {
    await tabsRemove(idsToClose);
  }

  return {
    closedCount: idsToClose.length,
    duplicateSets
  };
}

async function clearSavedSessions() {
  await saveSessions([]);
  return { cleared: true };
}

async function handleAutoTidy() {
  const settings = await loadSettings();
  if (settings.autoTidySchedule === "off") {
    return;
  }

  const activeTabs = await tabsQuery({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs[0];
  const activeDomain = activeTab?.url ? getDomain(activeTab.url) : null;

  if (activeDomain && isExcludedDomain(activeDomain, settings.excludedDomains)) {
    return;
  }

  await groupByDomain();
}

async function initialize() {
  const settings = await loadSettings();
  await storageSet({ [SETTINGS_KEY]: settings });

  const sessions = await loadSessions();
  if (!Array.isArray(sessions)) {
    await saveSessions([]);
  }

  await syncAutoTidyAlarm(settings);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((err) => console.error("Initialization failed on install:", err));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((err) => console.error("Initialization failed on startup:", err));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_TIDY_ALARM) {
    return;
  }

  handleAutoTidy().catch((err) => {
    console.error("Auto tidy alarm failed:", err);
  });
});

chrome.commands.onCommand.addListener((command) => {
  const map = {
    "group-by-domain": groupByDomain,
    "park-tabs": parkTabs,
    "close-duplicates": closeDuplicates
  };

  const commandHandler = map[command];
  if (!commandHandler) {
    return;
  }

  commandHandler().catch((err) => {
    console.error(`Command ${command} failed:`, err);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.action) {
      case "GROUP_BY_DOMAIN": {
        const result = await groupByDomain();
        sendResponse({ ok: true, result });
        return;
      }
      case "PARK_TABS": {
        const result = await parkTabs();
        sendResponse({ ok: true, result });
        return;
      }
      case "RESTORE_SESSION": {
        const result = await restoreSession(message.sessionId, message.target);
        sendResponse({ ok: true, result });
        return;
      }
      case "CLOSE_DUPLICATES": {
        const result = await closeDuplicates();
        sendResponse({ ok: true, result });
        return;
      }
      case "GET_SESSIONS": {
        const sessions = await loadSessions();
        sendResponse({ ok: true, result: { sessions } });
        return;
      }
      case "GET_SETTINGS": {
        const settings = await loadSettings();
        sendResponse({ ok: true, result: { settings } });
        return;
      }
      case "SAVE_SETTINGS": {
        const settings = await saveSettings(message.settings || {});
        sendResponse({ ok: true, result: { settings } });
        return;
      }
      case "CLEAR_SESSIONS": {
        const result = await clearSavedSessions();
        sendResponse({ ok: true, result });
        return;
      }
      default:
        sendResponse({ ok: false, error: "Unknown action." });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: toErrorMessage(err) });
  });

  return true;
});
