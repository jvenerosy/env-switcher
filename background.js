import { getEnvs, findEnv, badgeLabel, onEnvsChanged, textColorFor, checkStatus } from "./envs.js";

const ICONS = (state) => ({
  16: `icons/${state}-16.png`,
  32: `icons/${state}-32.png`,
  48: `icons/${state}-48.png`,
  128: `icons/${state}-128.png`,
});

async function refreshTab(tab, envs) {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  const env = tab.url ? findEnv(envs, tab.url) : null;
  try {
    if (env) {
      await chrome.action.setIcon({ tabId: tab.id, path: ICONS("active") });
      await chrome.action.setBadgeText({ tabId: tab.id, text: badgeLabel(env) });
      await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: env.color || "#006dc8" });
      await chrome.action.setBadgeTextColor?.({ tabId: tab.id, color: textColorFor(env.color) });
      await chrome.action.setTitle({ tabId: tab.id, title: `Env Switcher — ${env.name}` });
    } else {
      await chrome.action.setIcon({ tabId: tab.id, path: ICONS("inactive") });
      await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
      await chrome.action.setTitle({ tabId: tab.id, title: "Env Switcher — aucun environnement reconnu" });
    }
  } catch {
    // The tab may have been closed in the meantime.
  }
}

async function refreshAllTabs(envs) {
  envs = envs || (await getEnvs());
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => refreshTab(tab, envs)));
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status) refreshTab(tab, await getEnvs());
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    refreshTab(await chrome.tabs.get(tabId), await getEnvs());
  } catch {}
});

chrome.runtime.onInstalled.addListener(() => { refreshAllTabs(); ensureHealthAlarm(); checkHealth(); });
chrome.runtime.onStartup.addListener(() => { refreshAllTabs(); ensureHealthAlarm(); checkHealth(); });
onEnvsChanged((envs) => { refreshAllTabs(envs); checkHealth(); });

// ---- Health monitoring: periodic checks + notifications on state change ----

const HEALTH_ALARM = "health-check";
const HEALTH_PERIOD_MIN = 1;
const HEALTH_KEY = "health"; // chrome.storage.local: { [envId]: { up, at } }

async function ensureHealthAlarm() {
  if (!(await chrome.alarms.get(HEALTH_ALARM))) {
    chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_PERIOD_MIN, delayInMinutes: HEALTH_PERIOD_MIN });
  }
}
ensureHealthAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) checkHealth();
});

let checking = null;
function checkHealth() {
  // Avoid overlapping runs (alarm + env change at the same time).
  checking ??= runHealthCheck().finally(() => { checking = null; });
  return checking;
}

async function runHealthCheck() {
  const envs = await getEnvs();
  const prev = (await chrome.storage.local.get(HEALTH_KEY))[HEALTH_KEY] || {};
  const next = {};

  await Promise.all(envs.map(async (env) => {
    let up = await checkStatus(env.url);
    // Retry once before declaring it down, to avoid false alarms on a blip.
    if (!up) up = await checkStatus(env.url, 8000);
    next[env.id] = { up, at: Date.now() };
  }));

  const wentDown = envs.filter((e) => next[e.id].up === false && prev[e.id]?.up !== false);
  const cameBack = envs.filter((e) => next[e.id].up === true && prev[e.id]?.up === false);

  await chrome.storage.local.set({ [HEALTH_KEY]: next });

  if (wentDown.length) {
    notify("env-down", wentDown.length === 1
      ? `${wentDown[0].name} est hors ligne`
      : `${wentDown.length} environnements hors ligne`,
      wentDown.map((e) => `${e.name} — ${new URL(e.url).host}`).join("\n"));
  }
  if (cameBack.length) {
    notify("env-up", cameBack.length === 1
      ? `${cameBack[0].name} est de nouveau en ligne`
      : `${cameBack.length} environnements de nouveau en ligne`,
      cameBack.map((e) => `${e.name} — ${new URL(e.url).host}`).join("\n"));
  }
}

function notify(id, title, message) {
  chrome.notifications.create(`${id}-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/active-128.png",
    title,
    message,
    priority: 2,
  });
}
