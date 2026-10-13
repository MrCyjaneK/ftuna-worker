import { document } from "./html.ts";

const css = `
body { max-width: 46rem; }
.lead { margin-bottom: 1rem; }
.versions, .summary { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.versions[hidden] { display: none; }
.versions { margin: 0 0 0.9rem; }
.summary { margin: 0 0 1.15rem; }
.versions a, .summary button {
  font: inherit;
  font-size: 0.92rem;
  color: inherit;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.15rem 0.7rem;
  text-decoration: none;
}
.summary button { cursor: pointer; }
.versions a[aria-current="page"], .summary button[aria-pressed="true"] {
  background: var(--fg);
  color: var(--bg);
  border-color: var(--fg);
}
.n { font-variant-numeric: tabular-nums; font-weight: 600; margin-right: 0.3rem; }
.recipes { list-style: none; padding: 0; margin: 0; }
.recipes > li { border-top: 1px solid var(--line); }
.recipes > li:last-child { border-bottom: 1px solid var(--line); }
.recipes a { display: inline; padding: 0; }
.recipes a:hover { background: none; }
details > summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.85rem;
  position: relative;
  padding: 0.7rem 0.15rem 0.7rem 1.2rem;
  cursor: pointer;
  list-style: none;
}
details > summary::-webkit-details-marker { display: none; }
details > summary::marker { content: ""; }
details > summary::before {
  content: "";
  position: absolute;
  left: 0.05rem;
  top: 1.05rem;
  width: 0.35rem;
  height: 0.35rem;
  border-right: 1.5px solid var(--muted);
  border-bottom: 1.5px solid var(--muted);
  transform: rotate(-45deg);
}
details[open] > summary::before { top: 0.95rem; transform: rotate(45deg); }
details[open] > summary { background: var(--row); }
.name { flex: 1 1 12rem; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.name a { color: inherit; text-decoration: none; }
.name a:hover { color: var(--link); }
.icon { width: 1.25rem; height: 1.25rem; margin-right: 0.45rem; border-radius: 0.2rem; vertical-align: -0.2rem; object-fit: cover; }
.commit { color: var(--muted); font-size: 0.88rem; font-variant-numeric: tabular-nums; }
.state { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.state.failed { color: #9c3412; }
.state.building { color: var(--link); }
.state.built, .state.current { color: #1d6b3a; }
.state.pending { color: #8a5a00; }
.state.skipped { color: var(--muted); }
.more { padding: 0.15rem 0.15rem 0.9rem 1.2rem; }
.more p { margin: 0.4rem 0; }
.desc { white-space: pre-wrap; }
.meta, .arch { color: var(--muted); }
.arch { margin: 0.85rem 0 0.1rem; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.error { color: #9c3412; overflow-wrap: anywhere; }
.rpms { list-style: none; padding: 0; margin: 0.1rem 0 0.35rem; }
.rpms li, .rpms li:last-child { border: 0; margin: 0.12rem 0; }
.rpms a { color: var(--link); overflow-wrap: anywhere; }
.rpms a:hover { text-decoration: underline; }
.log {
  font: 0.78rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 18rem;
  overflow: auto;
  background: var(--row);
  padding: 0.65rem 0.75rem;
  margin: 0.7rem 0 0;
}
@media (prefers-color-scheme: dark) {
  .state.failed, .error { color: #ffb4a2; }
  .state.built, .state.current { color: #97d8ae; }
  .state.pending { color: #f0c36a; }
}
`;

const script = `
const VERSION = /^\\d+\\.\\d+\\.\\d+\\.\\d+$/;
const STATES = ["building", "failed", "pending", "built", "current", "skipped"];
const lead = document.querySelector("#lead");
const versionsEl = document.querySelector("#versions");
const summaryEl = document.querySelector("#summary");
const listEl = document.querySelector("#list");
let ticket = 0;
let status = null;
let filter = "";
let version = "";

addEventListener("hashchange", function () { load(); });
load();

async function load() {
  const mine = ++ticket;
  filter = "";
  lead.textContent = "Loading…";
  summaryEl.replaceChildren();
  listEl.replaceChildren();
  let versions = [];
  try {
    versions = await listVersions();
  } catch (err) {
    versions = [];
  }
  if (mine !== ticket) return;
  let hash = "";
  try { hash = decodeURIComponent(location.hash.slice(1)); } catch (err) { hash = ""; }
  version = VERSION.test(hash) ? hash : (versions[0] || "");
  if (!version) {
    lead.textContent = "No Sailfish OS versions in the catalog.";
    renderVersions([]);
    return;
  }
  if (versions.indexOf(version) === -1) versions.unshift(version);
  if (location.hash !== "#" + version) history.replaceState(null, "", "#" + version);
  renderVersions(versions);
  lead.textContent = "Loading " + version + "…";
  try {
    const response = await fetch("/" + encodeURIComponent(version) + "/status.json");
    if (!response.ok) throw new Error(String(response.status));
    status = await response.json();
  } catch (err) {
    if (mine !== ticket) return;
    lead.textContent = "Could not load " + version + "/status.json.";
    return;
  }
  if (mine !== ticket) return;
  render();
}

async function listVersions() {
  const response = await fetch("/", { headers: { accept: "text/html" } });
  if (!response.ok) throw new Error(String(response.status));
  const html = await response.text();
  const found = new Set();
  const pattern = /href="(\\d+\\.\\d+\\.\\d+\\.\\d+)\\/"/g;
  let match;
  while ((match = pattern.exec(html))) found.add(match[1]);
  return Array.from(found).sort(compareVersions);
}

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const diff = (right[i] || 0) - (left[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function renderVersions(versions) {
  versionsEl.replaceChildren();
  versionsEl.hidden = versions.length === 0;
  for (const item of versions) {
    const link = document.createElement("a");
    link.href = "#" + item;
    link.textContent = item;
    if (item === version) link.setAttribute("aria-current", "page");
    versionsEl.append(link);
  }
}

function render() {
  const when = formatTime(status.updated);
  lead.textContent = (status.sfos || version) + (when ? " · updated " + when : "");
  renderSummary();
  renderList();
}

function renderSummary() {
  const counts = countStates(status);
  summaryEl.replaceChildren();
  summaryEl.append(filterButton("", counts[""], "all"));
  for (const state of STATES) summaryEl.append(filterButton(state, counts[state], state));
}

function filterButton(state, count, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.state = state;
  button.setAttribute("aria-pressed", String(filter === state));
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(count);
  button.append(n, document.createTextNode(label));
  button.addEventListener("click", function () {
    filter = state;
    for (const peer of summaryEl.querySelectorAll("button")) {
      peer.setAttribute("aria-pressed", String(peer.dataset.state === filter));
    }
    renderList();
  });
  return button;
}

function countStates(data) {
  const summary = data.summary || {};
  const recipes = Array.isArray(data.recipes) ? data.recipes : [];
  const counts = { "": summary.recipes != null ? summary.recipes : recipes.length };
  for (const state of STATES) {
    if (summary[state] != null) counts[state] = summary[state];
    else counts[state] = recipes.filter(function (recipe) { return recipe.state === state; }).length;
  }
  return counts;
}

function renderList() {
  listEl.replaceChildren();
  const recipes = (Array.isArray(status.recipes) ? status.recipes : [])
    .filter(function (recipe) { return !filter || recipe.state === filter; })
    .sort(function (a, b) {
      return rank(a.state) - rank(b.state) || String(a.name || "").localeCompare(String(b.name || ""));
    });
  if (recipes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "detail";
    empty.textContent = "Nothing in this state.";
    listEl.append(empty);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "recipes";
  for (const recipe of recipes) ul.append(recipeItem(recipe));
  listEl.append(ul);
}

function rank(state) {
  const index = STATES.indexOf(state);
  return index === -1 ? STATES.length : index;
}

function recipeItem(recipe) {
  const li = document.createElement("li");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const name = document.createElement("span");
  name.className = "name";
  const icon = httpURL(recipe.icon);
  if (icon) {
    const img = document.createElement("img");
    img.className = "icon";
    img.alt = "";
    img.src = icon;
    img.addEventListener("error", function () { img.remove(); });
    name.append(img);
  }
  const href = httpURL(recipe.url);
  const label = recipe.name || recipe.id || "recipe";
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    name.append(link);
  } else {
    name.append(document.createTextNode(label));
  }
  const state = document.createElement("span");
  state.className = "state" + (recipe.state ? " " + recipe.state : "");
  state.textContent = recipe.state || "";
  const commit = document.createElement("span");
  commit.className = "commit";
  commit.textContent = commitLabel(recipe);
  summary.append(name, state, commit);
  details.append(summary, recipeBody(recipe, details));
  li.append(details);
  return li;
}

function recipeBody(recipe, details) {
  const body = document.createElement("div");
  body.className = "more";
  if (recipe.description) {
    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent = recipe.description;
    body.append(desc);
  }
  const bits = [];
  if (recipe.id) bits.push(recipe.id);
  if (recipe.path && recipe.path !== ".") bits.push(recipe.path);
  if (Array.isArray(recipe.arches) && recipe.arches.length) bits.push(recipe.arches.join(", "));
  if (bits.length) {
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = bits.join(" · ");
    body.append(meta);
  }
  if (recipe.failed_at) {
    const failed = document.createElement("p");
    failed.className = "meta";
    const when = formatTime(recipe.failed_at);
    failed.textContent = when ? "Failed " + when : "Failed " + recipe.failed_at;
    body.append(failed);
  }
  const rpms = recipe.rpms || {};
  const arches = archOrder(recipe, rpms);
  for (const arch of arches) {
    const packages = Array.isArray(rpms[arch]) ? rpms[arch].slice() : [];
    if (packages.length === 0) continue;
    packages.sort(function (a, b) { return rpmRank(a) - rpmRank(b) || String(a.name || "").localeCompare(String(b.name || "")); });
    const heading = document.createElement("p");
    heading.className = "arch";
    heading.textContent = arch;
    body.append(heading);
    const ul = document.createElement("ul");
    ul.className = "rpms";
    for (const rpm of packages) {
      const item = document.createElement("li");
      const text = rpmLabel(rpm);
      const href = rpmHref(arch, rpm.file);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = text;
        item.append(link);
      } else {
        item.textContent = text;
      }
      ul.append(item);
    }
    body.append(ul);
  }
  appendLog(body, details, recipe.error);
  appendLog(body, details, recipe.log);
  return body;
}

function appendLog(body, details, text) {
  if (typeof text !== "string" || !text.trim()) return;
  const pre = document.createElement("pre");
  pre.className = "log";
  details.addEventListener("toggle", function () {
    if (details.open && pre.textContent === "") pre.textContent = text;
  });
  body.append(pre);
}

function archOrder(recipe, rpms) {
  const keys = Object.keys(rpms);
  const preferred = Array.isArray(recipe.arches) ? recipe.arches.filter(function (arch) { return keys.indexOf(arch) !== -1; }) : [];
  const rest = keys.filter(function (arch) { return preferred.indexOf(arch) === -1; });
  return preferred.concat(rest);
}

function rpmRank(rpm) {
  const name = String(rpm.name || "");
  return name.endsWith("-debuginfo") || name.endsWith("-debugsource") ? 1 : 0;
}

function rpmLabel(rpm) {
  const version = rpm.version && rpm.release ? rpm.version + "-" + rpm.release : rpm.version;
  return [rpm.name, version].filter(Boolean).join(" ") || rpm.file || "package";
}

function rpmHref(arch, file) {
  if (typeof file !== "string" || file === "") return "";
  const parts = file.split("/");
  if (parts.some(function (part) { return part === "" || part === "." || part === ".."; })) return "";
  return "/" + [version, arch].concat(parts).map(encodeURIComponent).join("/");
}

function commitLabel(recipe) {
  const commit = short(recipe.commit);
  const published = short(recipe.published_commit);
  if (commit && published && recipe.commit !== recipe.published_commit) return commit + " · published " + published;
  return commit || published;
}

function short(value) {
  return typeof value === "string" && value ? value.slice(0, 10) : "";
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return day + " " + months[date.getUTCMonth()] + " " + date.getUTCFullYear() + ", " + hours + ":" + minutes + " UTC";
}

function httpURL(value) {
  if (typeof value !== "string" || value === "") return "";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch (err) {}
  return "";
}
`;

export const statusPage = document(
  "Packaging",
  `<p class="brand"><a href="https://ftuna.eu/">FTuna</a></p>
<h1>Packaging</h1>
<p class="lead" id="lead" aria-live="polite">Loading…</p>
<nav id="versions" class="versions" aria-label="Sailfish OS version" hidden></nav>
<div id="summary" class="summary" role="group" aria-label="Recipe state"></div>
<div id="list"></div>
<script>${script}</script>`,
  css,
);

export const statusText =
  [
    "Packaging",
    "Sailfish OS build status for the FTuna OSS catalog.",
    "",
    "Open https://repo-oss.ftuna.eu/status in a browser.",
    "Each version directory has a status.json file.",
  ].join("\n") + "\n";
