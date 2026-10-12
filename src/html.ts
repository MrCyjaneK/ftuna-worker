import { marked } from "marked";
import { listPrefix, type StoreRequest } from "./site.ts";

const css = `
:root {
  color-scheme: light dark;
  --bg: #f6f5f2;
  --fg: #1a1916;
  --muted: #5e5a54;
  --line: #e4e0d8;
  --link: #0b57d0;
  --row: #efeee9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141311;
    --fg: #eceae4;
    --muted: #a39e94;
    --line: #2e2c28;
    --link: #9ec1ff;
    --row: #1e1c19;
  }
}
html { background: var(--bg); color: var(--fg); }
body {
  font: 17px/1.45 ui-sans-serif, system-ui, sans-serif;
  max-width: 42rem;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
}
h1 { font-size: 1.6rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 0.4rem; }
.lead, .detail, .size, .brand { color: var(--muted); }
.lead { margin: 0 0 1.75rem; }
ul { list-style: none; padding: 0; margin: 0; }
li { border-top: 1px solid var(--line); }
li:last-child { border-bottom: 1px solid var(--line); }
li a { display: block; padding: 0.75rem 0.15rem; color: inherit; text-decoration: none; }
li a:hover { background: var(--row); }
.title { font-weight: 600; }
.host { display: block; color: var(--link); font-size: 0.92rem; }
.detail { display: block; font-size: 0.92rem; }
.brand { font-size: 0.92rem; margin: 0 0 0.8rem; }
.brand a { color: var(--link); }
table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
th, td { text-align: left; padding: 0.4rem 0.35rem; border-bottom: 1px solid var(--line); vertical-align: baseline; }
th { color: var(--muted); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
td.size, th.size { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td a { color: var(--link); text-decoration: none; overflow-wrap: anywhere; }
td a:hover { text-decoration: underline; }
tr:hover td { background: var(--row); }
a:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
h2 { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.01em; margin: 1.8rem 0 0.35rem; }
.doc { overflow-wrap: break-word; }
.doc p { margin: 0.65rem 0; }
.doc ul, .doc ol { margin: 0.35rem 0 0.9rem; padding: 0 0 0 1.25rem; }
.doc ul { list-style: disc; }
.doc ol { list-style: decimal; }
.doc li, .doc li:last-child { border: 0; margin: 0.15rem 0; }
.doc li a { display: inline; padding: 0; color: var(--link); }
.doc li a:hover { background: none; }
.doc a { color: var(--link); }
.doc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
  overflow-wrap: anywhere;
}
`;

const sites = [
  ["https://repo-oss.ftuna.eu/", "FTuna OSS", "repo-oss.ftuna.eu", "Official catalog. Open source."],
  ["https://repo-oss.ftuna.eu/status", "Packaging", "repo-oss.ftuna.eu/status", "Build status for the open source catalog."],
  ["https://repo-openrepos.ftuna.eu/", "OpenRepos", "repo-openrepos.ftuna.eu", "Mirror of openrepos.net"],
  ["https://scratchpad-repo.ftuna.eu/", "Scratch", "scratchpad-repo.ftuna.eu", "Unsigned one-off builds, temporary."],
  ["https://cdn-mirror.ftuna.eu/", "CDN", "cdn-mirror.ftuna.eu", "Icons, screenshots and other external resources."],
  ["/files/", "Files", "ftuna.eu/files/", "All of the above."],
] as const;

export const homePage = document(
  "FTuna",
  `<h1>FTuna</h1>
<p class="lead">Sailfish OS catalogs and mirrors.</p>
<ul>
${sites
  .map(
    ([href, title, host, detail]) =>
      `<li><a href="${href}"><span class="title">${escapeHtml(title)}</span><span class="host">${escapeHtml(host)}</span><span class="detail">${escapeHtml(detail)}</span></a></li>`,
  )
  .join("\n")}
</ul>`,
);

const homeLines = sites.map(([href, title, , detail]) => ({
  url: href.startsWith("/") ? "https://ftuna.eu" + href : href,
  label: `${title} — ${detail}`,
}));
const homeURLWidth = Math.max(...homeLines.map((line) => line.url.length));

export const homeText =
  [
    "FTuna",
    "Sailfish OS catalogs and mirrors.",
    "",
    ...homeLines.map((line) => `${line.url.padEnd(homeURLWidth)}  ${line.label}`),
  ].join("\n") + "\n";

export function indexHTML(req: StoreRequest, dirs: string[], files: { key: string; size: number }[]): string {
  const title = indexTitle(req);
  const brand =
    req.prefix === "repo/ftuna-oss" && req.path === ""
      ? `<p class="brand"><a href="https://ftuna.eu/">FTuna</a> · <a href="/status">Packaging</a></p>`
      : `<p class="brand"><a href="https://ftuna.eu/">FTuna</a></p>`;
  return document(
    title,
    `${brand}
<h1>${escapeHtml(title)}</h1>
${listingTable(req, dirs, files)}`,
  );
}

export function docsHTML(markdown: string, req: StoreRequest, dirs: string[], files: { key: string; size: number }[]): string {
  return document(
    "Scratchpad",
    `<p class="brand"><a href="https://ftuna.eu/">FTuna</a></p>
<article class="doc">
${renderMarkdown(markdown)}
</article>
<h2>${escapeHtml(indexTitle(req))}</h2>
${listingTable(req, dirs, files)}`,
  );
}

export function docsText(markdown: string, req: StoreRequest, dirs: string[], files: { key: string; size: number }[]): string {
  return markdown.trimEnd() + "\n\n" + indexText(req, dirs, files);
}

export function indexText(req: StoreRequest, dirs: string[], files: { key: string; size: number }[]): string {
  const lines = [indexTitle(req), ""];
  for (const row of listingRows(req, dirs, files)) {
    lines.push(row.size === "" ? row.label : `${row.label}  ${row.size}`);
  }
  return lines.join("\n") + "\n";
}

function indexTitle(req: StoreRequest): string {
  return "Index of /" + (req.path === "" ? "" : req.path + "/");
}

function listingRows(req: StoreRequest, dirs: string[], files: { key: string; size: number }[]) {
  const prefix = listPrefix(req.prefix, req.path);
  const rows = [
    ...dirs.map((key) => ({ label: relName(prefix, key), size: "", dir: true })),
    ...files.map((file) => ({ label: relName(prefix, file.key), size: formatSize(file.size), dir: false })),
  ].sort((a, b) => Number(b.dir) - Number(a.dir) || a.label.localeCompare(b.label));
  if (req.path !== "") rows.unshift({ label: "../", size: "", dir: true });
  return rows;
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  if (i === 0) return `${Math.trunc(n)} B`;
  const text = n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
  return `${text} ${units[i]}`;
}

export function document(title: string, body: string, extraCss = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141311" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(title)}</title>
<style>${css}${extraCss}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function listingTable(req: StoreRequest, dirs: string[], files: { key: string; size: number }[]): string {
  const rows = listingRows(req, dirs, files).map(
    (row) =>
      `<tr><td><a href="${escapeHtml(encodeHref(row.label))}">${escapeHtml(row.label)}</a></td><td class="size">${escapeHtml(row.size)}</td></tr>`,
  );
  return `<table>
<thead><tr><th>Name</th><th class="size">Size</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
}

function renderMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

function relName(prefix: string, key: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function encodeHref(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
