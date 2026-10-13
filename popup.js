import { getEnvs, saveEnvs, findEnv, buildTargetUrl, newId, getSettings, checkStatus } from "./envs.js";

const POPUP_RECHECK_MS = 15000;

function setStatus(el, env, up) {
  el.className = "status " + (up ? "is-up" : "is-down");
  el.dataset.label = up ? "en ligne" : "hors ligne";
  el.title = (up ? `En ligne — ${env.url}` : `Hors ligne — ${env.url}`) +
    ` · vérifié à ${new Date().toLocaleTimeString()}`;
}

const $ = (id) => document.getElementById(id);

function dot(color) {
  const el = document.createElement("span");
  el.className = "dot";
  el.style.background = color || "#999";
  return el;
}

async function go(tab, url, inNewTab) {
  if (inNewTab || !tab) {
    await chrome.tabs.create({ url, ...(tab ? { index: tab.index + 1, openerTabId: tab.id } : {}) });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
  window.close();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const envs = await getEnvs();
  const { openInNewTab } = await getSettings();
  // The preference sets the default; ⌘/Ctrl inverts it.
  const wantsNewTab = (inverted) => openInNewTab !== Boolean(inverted);

  $("hint").textContent = openInNewTab
    ? "Clic : nouvel onglet · ⌘/Ctrl+clic : même onglet"
    : "Clic : même onglet · ⌘/Ctrl+clic : nouvel onglet";
  const current = tab?.url ? findEnv(envs, tab.url) : null;

  $("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // On a known env, keep the same path; otherwise open the env's home page.
  const targetFor = (env) => current ? buildTargetUrl(tab.url, env) : `${env.url}/`;

  if (!current) {
    $("current").textContent = "Aucun environnement";
    let page;
    try { page = new URL(tab.url); } catch {}
    $("path").textContent = page ? page.host : "";
    if (page && /^https?:$/.test(page.protocol)) {
      $("unknown").hidden = false;
      $("add-current").textContent = `Ajouter ${page.host}`;
      $("add-current").addEventListener("click", async () => {
        envs.push({ id: newId(), name: page.hostname, url: page.origin, short: "", color: "#6b7280" });
        await saveEnvs(envs);
        chrome.runtime.openOptionsPage();
        window.close();
      });
    }
  } else {
    const page = new URL(tab.url);
    $("current").append(dot(current.color), document.createTextNode(current.name));
    $("path").textContent = page.pathname + page.search + page.hash;
    $("path").title = $("path").textContent;
  }

  const list = $("envs");
  envs.forEach((env, index) => {
    const isCurrent = env.id === current?.id;
    const li = document.createElement("li");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "env" + (isCurrent ? " is-current" : "");
    btn.dataset.index = index;

    const key = document.createElement("span");
    key.className = "key";
    key.textContent = index < 9 ? String(index + 1) : "";

    const label = document.createElement("span");
    label.className = "label";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = env.name;
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = new URL(env.url).host;
    label.append(name, host);

    const status = document.createElement("span");
    status.className = "status is-checking";
    status.dataset.label = "vérification…";
    status.title = "Vérification en cours";
    const recheck = () => checkStatus(env.url).then((up) => setStatus(status, env, up));
    recheck();
    setInterval(recheck, POPUP_RECHECK_MS);

    btn.append(key, dot(env.color), label, status);
    li.append(btn);

    if (!isCurrent) {
      btn.title = targetFor(env);
      btn.addEventListener("click", (e) => go(tab, targetFor(env), wantsNewTab(e.metaKey || e.ctrlKey)));
      btn.addEventListener("auxclick", (e) => { if (e.button === 1) go(tab, targetFor(env), true); });

      // Secondary button: the opposite of the default behaviour.
      const alt = document.createElement("button");
      alt.type = "button";
      alt.className = "newtab";
      alt.title = openInNewTab ? "Ouvrir dans cet onglet" : "Ouvrir dans un nouvel onglet";
      alt.textContent = openInNewTab ? "↩" : "↗";
      alt.addEventListener("click", () => go(tab, targetFor(env), !openInNewTab));
      li.append(alt);
    } else {
      btn.disabled = true;
    }

    list.append(li);
  });

  // Keyboard shortcuts: 1-9 switches, ⌘/Ctrl inverts the new-tab preference.
  // Uses e.code so it works on AZERTY too (digits need Shift there).
  document.addEventListener("keydown", (e) => {
    const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (!match) return;
    const env = envs[Number(match[1]) - 1];
    if (env && env.id !== current?.id) go(tab, targetFor(env), wantsNewTab(e.metaKey || e.ctrlKey));
  });

  list.querySelector(".env:not(.is-current)")?.focus();
}

init();
