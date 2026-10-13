import { DEFAULT_ENVS, getEnvs, saveEnvs, onEnvsChanged, normalizeOrigin, newId, getSettings, saveSettings, ENV_TYPES, buildEnvUrl, splitHost } from "./envs.js";

const isTyped = (env) => Boolean(ENV_TYPES[env.type]?.suffix);
// Name/badge suggested from the type, e.g. "ap2" / "AP2".
const autoName = (env) => isTyped(env) ? `${env.type}${ENV_TYPES[env.type].number === "none" ? "" : (env.num || "")}` : "";

const $ = (id) => document.getElementById(id);
const rowsEl = $("rows");
const template = $("row-template");

let envs = [];
let lastSaved = "";
let saveTimer = null;

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// Returns a list of { index, field, message }.
function validate(list) {
  const errors = [];
  const hosts = new Map();
  list.forEach((env, index) => {
    if (!env.name.trim()) errors.push({ index, field: "name", message: "Nom manquant" });
    if (isTyped(env) && ENV_TYPES[env.type].number === "required" && !String(env.num || "").trim()) {
      errors.push({ index, field: "num", message: `Numéro ${env.type} manquant` });
      return;
    }
    const origin = normalizeOrigin(env.url);
    if (!origin) {
      errors.push({ index, field: "url", message: "URL invalide" });
      return;
    }
    const host = new URL(origin).host;
    if (hosts.has(host)) errors.push({ index, field: "url", message: `${host} est déjà utilisé` });
    hosts.set(host, index);
  });
  return errors;
}

function clean(list) {
  return list.map((env) => {
    const out = {
      id: env.id || newId(),
      name: env.name.trim(),
      url: normalizeOrigin(env.url),
      short: (env.short || "").trim().toUpperCase().slice(0, 4),
      color: env.color || "#6b7280",
    };
    if (isTyped(env)) {
      out.type = env.type;
      if (ENV_TYPES[env.type].number !== "none" && String(env.num || "").trim()) out.num = String(env.num).trim();
    }
    return out;
  });
}

// Copies the optional type fields from an imported/stored object.
function typeFields(env) {
  if (!ENV_TYPES[env.type]?.suffix) return {};
  return { type: env.type, num: env.num != null ? String(env.num) : "" };
}

function showErrors(errors) {
  rowsEl.querySelectorAll("input.invalid").forEach((el) => {
    el.classList.remove("invalid");
    el.removeAttribute("title");
  });
  for (const { index, field, message } of errors) {
    const input = rowsEl.children[index]?.querySelector(`.f-${field}`);
    if (input) {
      input.classList.add("invalid");
      input.title = message;
    }
  }
}

async function persist() {
  clearTimeout(saveTimer);
  const errors = validate(envs);
  showErrors(errors);
  if (errors.length) {
    setStatus(`Non enregistré : ${errors[0].message}${errors.length > 1 ? ` (+${errors.length - 1})` : ""}`, true);
    return;
  }
  const cleaned = clean(envs);
  lastSaved = JSON.stringify(cleaned);
  await saveEnvs(cleaned);
  setStatus("Enregistré ✓");
}

function schedulePersist() {
  clearTimeout(saveTimer);
  setStatus("…");
  saveTimer = setTimeout(persist, 400);
}

function move(from, to) {
  if (to < 0 || to >= envs.length || from === to) return;
  const [item] = envs.splice(from, 1);
  envs.splice(to, 0, item);
  render();
  persist();
}

function render() {
  rowsEl.replaceChildren();
  envs.forEach((env, index) => {
    const row = template.content.firstElementChild.cloneNode(true);
    const f = (name) => row.querySelector(`.f-${name}`);

    f("color").value = /^#[0-9a-f]{6}$/i.test(env.color) ? env.color : "#6b7280";
    f("name").value = env.name;
    f("short").value = env.short || "";
    f("url").value = env.url;

    // Type / number: only the first part of the host follows the type; the rest
    // of the URL is prefilled with the type's default and stays editable.
    const typeSel = f("type");
    for (const [value, { label }] of Object.entries(ENV_TYPES)) {
      typeSel.append(new Option(label, value));
    }
    const syncTypeUi = () => {
      const e = envs[index];
      const t = ENV_TYPES[e.type];
      const typed = isTyped(e);
      typeSel.value = typed ? e.type : "autre";
      f("num").hidden = !typed || t.number === "none";
      f("num").placeholder = t?.number === "optional" ? "(n°)" : "n°";
      f("num").value = e.num || "";
      f("url").value = e.url || "";
    };
    // Rewrites the host prefix (and auto name/badge if the user didn't customise them).
    const applyType = (mutate) => {
      const e = envs[index];
      const prevAuto = autoName(e);
      const prevType = e.type;
      mutate(e);
      if (isTyped(e)) {
        // Keep the user's suffix, unless it is still the previous type's default
        // (e.g. ap -> preprod switches ocp-1… to ocp-3…).
        const cur = splitHost(e.url);
        const prevDefault = ENV_TYPES[prevType]?.suffix;
        const base = !cur || !cur.suffix || cur.suffix === prevDefault ? "" : e.url;
        e.url = buildEnvUrl(e, base);
        const next = autoName(e);
        if (!e.name.trim() || e.name === prevAuto) e.name = f("name").value = next;
        if (!(e.short || "").trim() || e.short.toUpperCase() === prevAuto.toUpperCase().slice(0, 4)) {
          e.short = f("short").value = next.toUpperCase().slice(0, 4);
        }
      }
      syncTypeUi();
      schedulePersist();
    };
    typeSel.addEventListener("change", () => applyType((e) => {
      if (typeSel.value === "autre") {
        delete e.type; delete e.num;
      } else {
        e.type = typeSel.value;
        if (ENV_TYPES[e.type].number === "none") e.num = "";
      }
    }));
    f("num").addEventListener("input", (ev) => applyType((e) => { e.num = ev.target.value.trim(); }));
    syncTypeUi();

    for (const field of ["color", "name", "short", "url"]) {
      f(field).addEventListener("input", (e) => {
        envs[index][field] = e.target.value;
        schedulePersist();
      });
    }
    // Normalise the URL once the user leaves the field.
    f("url").addEventListener("change", (e) => {
      const origin = normalizeOrigin(e.target.value);
      if (origin) e.target.value = envs[index].url = origin;
      persist();
    });

    row.querySelector(".up").disabled = index === 0;
    row.querySelector(".down").disabled = index === envs.length - 1;
    row.querySelector(".up").addEventListener("click", () => move(index, index - 1));
    row.querySelector(".down").addEventListener("click", () => move(index, index + 1));
    row.querySelector(".delete").addEventListener("click", () => {
      if (!confirm(`Supprimer « ${env.name || env.url || "cet environnement"} » ?`)) return;
      envs.splice(index, 1);
      render();
      persist();
    });

    setupDrag(row, index);
    rowsEl.append(row);
  });
  showErrors(validate(envs));
}

// Drag & drop reordering, only when grabbed by the handle.
let dragFrom = null;
function setupDrag(row, index) {
  const handle = row.querySelector(".handle");
  row.draggable = false;
  handle.addEventListener("mousedown", () => { row.draggable = true; });
  row.addEventListener("mouseup", () => { row.draggable = false; });

  row.addEventListener("dragstart", (e) => {
    dragFrom = index;
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  });
  row.addEventListener("dragend", () => {
    row.draggable = false;
    row.classList.remove("dragging");
    rowsEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    dragFrom = null;
  });
  row.addEventListener("dragover", (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    row.classList.toggle("drop-after", after);
    row.classList.toggle("drop-before", !after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragFrom === null) return;
    const after = row.classList.contains("drop-after");
    let to = index + (after ? 1 : 0);
    if (dragFrom < to) to -= 1;
    move(dragFrom, to);
  });
}

$("add").addEventListener("click", () => {
  const env = { id: newId(), name: "", url: "", short: "", color: "#6b7280", type: "ap", num: "" };
  env.url = buildEnvUrl(env, "");
  envs.push(env);
  render();
  rowsEl.lastElementChild?.querySelector(".f-num").focus();
  setStatus("Choisis le type et le numéro ; le reste de l'URL est prérempli et modifiable.");
});

$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ environments: clean(envs.filter((e) => normalizeOrigin(e.url))) }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "env-switcher.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.environments;
    if (!Array.isArray(list)) throw new Error("format inattendu");
    const imported = list.map((env) => ({
      id: env.id || newId(),
      name: String(env.name || ""),
      url: String(env.url || env.hostname || buildEnvUrl(env, "") || ""),
      short: String(env.short || ""),
      color: String(env.color || "#6b7280"),
      ...typeFields(env),
    }));
    const errors = validate(imported);
    if (errors.length) throw new Error(`ligne ${errors[0].index + 1} : ${errors[0].message}`);
    if (!confirm(`Remplacer la configuration actuelle par ${imported.length} environnement(s) ?`)) return;
    envs = imported;
    render();
    await persist();
  } catch (err) {
    setStatus(`Import impossible : ${err.message}`, true);
  }
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Revenir à la configuration par défaut ?")) return;
  envs = structuredClone(DEFAULT_ENVS);
  render();
  await persist();
});

// Keep in sync if the config changes elsewhere (e.g. "Ajouter" from the popup).
onEnvsChanged((next) => {
  if (JSON.stringify(next) === lastSaved) return;
  envs = structuredClone(next);
  lastSaved = JSON.stringify(next);
  render();
});

$("pref-new-tab").addEventListener("change", async (e) => {
  await saveSettings({ ...(await getSettings()), openInNewTab: e.target.checked });
  setStatus("Préférence enregistrée ✓");
});

(async () => {
  $("pref-new-tab").checked = (await getSettings()).openInNewTab;
  envs = structuredClone(await getEnvs());
  lastSaved = JSON.stringify(envs);
  render();
})();
