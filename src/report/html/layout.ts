import type { Severity } from '../../core/types.js';

/**
 * The shared HTML shell.
 *
 * Everything is inlined - no stylesheet links, no script tags, no fonts, no
 * CDN. A report is downloaded as a pipeline artifact and opened from a local
 * filesystem, frequently with no network at all, so any external reference
 * would silently render an unstyled page at exactly the moment someone needs to
 * read it.
 *
 * Plain template literals rather than a framework: the output is static, and a
 * build step for the reporter would be cost with no benefit.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Coerce an arbitrary value to display text.
 *
 * Findings carry `expected` / `actual` as `unknown` - a string for text drift, a
 * number for a price, an object for a geometry box. Plain `String()` on the
 * last of those yields "[object Object]", which is worse than useless in a
 * report, so objects are JSON-encoded instead.
 */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Escape text for HTML.
 *
 * Report content comes from the crawled sites, which are untrusted input as far
 * as this document is concerned: a page whose heading contains `<script>` must
 * not execute it in whoever opens the report.
 */
export function escapeHtml(value: unknown): string {
  return toText(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Escape for a `"` -quoted HTML attribute. */
export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

/** Render a value that may be a string, number, null or an object. */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '<em class="muted">none</em>';
  if (value === '') return '<em class="muted">empty</em>';
  return escapeHtml(value);
}

export interface NavLink {
  href: string;
  label: string;
  current?: boolean;
}

export interface LayoutOptions {
  title: string;
  subtitle?: string;
  /** Relative prefix back to the report root: '', '../' or '../../'. */
  root: string;
  nav: NavLink[];
  body: string;
  /** Rendered directly before </body>, for page-specific behaviour. */
  script?: string;
}

const STYLES = `
:root {
  --bg: #f7f8fa; --panel: #ffffff; --ink: #1a1d21; --muted: #6b7280;
  --line: #e3e6ea; --accent: #12355b;
  --error: #b00020; --error-bg: #fdecef;
  --warning: #a05a00; --warning-bg: #fff5e6;
  --info: #33608f; --info-bg: #eef4fa;
  --ok: #1b7f4d; --ok-bg: #eaf7f0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a; --panel: #1c2024; --ink: #e8eaed; --muted: #9aa3ad;
    --line: #2c3238; --accent: #7fb2e5;
    --error: #ff8a9b; --error-bg: #3a1f26;
    --warning: #ffc46b; --warning-bg: #3a2e1a;
    --info: #8fc0f0; --info-bg: #1e2a36;
    --ok: #6fd39b; --ok-bg: #1b2f24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.muted { color: var(--muted); }
header.top { background: var(--accent); color: #fff; padding: 18px 24px; }
@media (prefers-color-scheme: dark) { header.top { background: #10243a; } }
header.top h1 { margin: 0; font-size: 19px; font-weight: 650; }
header.top p { margin: 4px 0 0; opacity: .85; font-size: 13px; }
nav.tabs {
  display: flex; flex-wrap: wrap; gap: 2px; padding: 0 24px;
  background: var(--panel); border-bottom: 1px solid var(--line);
}
nav.tabs a {
  padding: 11px 14px; text-decoration: none; color: var(--muted);
  border-bottom: 2px solid transparent; font-size: 14px;
}
nav.tabs a.current { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
main { padding: 24px; max-width: 1400px; margin: 0 auto; }
section { margin-bottom: 32px; }
h2 { font-size: 17px; margin: 0 0 12px; }
h3 { font-size: 15px; margin: 22px 0 8px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 13px 15px; }
.stat .value { font-size: 25px; font-weight: 650; line-height: 1.15; }
.stat .label { font-size: 12px; color: var(--muted); margin-top: 3px; }
.stat .denom { font-size: 11px; color: var(--muted); margin-top: 2px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; background: var(--panel); font-size: 14px; }
th, td { text-align: left; padding: 8px 11px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
tbody tr:hover { background: var(--bg); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge {
  display: inline-block; padding: 1px 7px; border-radius: 20px;
  font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .03em;
}
.badge.error { background: var(--error-bg); color: var(--error); }
.badge.warning { background: var(--warning-bg); color: var(--warning); }
.badge.info { background: var(--info-bg); color: var(--info); }
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.cell-0 { color: var(--muted); }
.cell-hit { font-weight: 650; }
.cell-error { background: var(--error-bg); color: var(--error); }
.cell-warning { background: var(--warning-bg); color: var(--warning); }
.finding { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); margin-bottom: 10px; }
.finding > summary { padding: 10px 14px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
.finding > summary::marker { color: var(--muted); }
.finding .title { flex: 1; }
.finding .body { padding: 0 14px 14px; border-top: 1px solid var(--line); }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 12px; margin-top: 10px; font-size: 13px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; word-break: break-word; }
.diffpair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.diffpair .side { min-width: 0; }
.diffpair .side .head { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.diffpair .val {
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  padding: 8px 10px; word-break: break-word; white-space: pre-wrap;
}
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 12px; }
.shots figure { margin: 0; }
.shots figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.shots img { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; align-items: center; }
.controls input, .controls select {
  font: inherit; font-size: 14px; padding: 6px 9px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
}
.controls input { flex: 1; min-width: 200px; }
.empty { padding: 26px; text-align: center; color: var(--muted); }
footer { padding: 20px 24px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
`;

/** Client-side filtering. Progressive: without JS the tables still render. */
const FILTER_SCRIPT = `
(function () {
  var search = document.getElementById('filter-text');
  var severity = document.getElementById('filter-severity');
  if (!search && !severity) return;

  function apply() {
    var term = (search && search.value || '').toLowerCase();
    var sev = severity && severity.value || '';
    var shown = 0;
    document.querySelectorAll('[data-filterable]').forEach(function (row) {
      var haystack = (row.getAttribute('data-search') || row.textContent || '').toLowerCase();
      var rowSev = row.getAttribute('data-severity') || '';
      var ok = (!term || haystack.indexOf(term) !== -1) && (!sev || rowSev === sev);
      row.hidden = !ok;
      if (ok) shown++;
    });
    var count = document.getElementById('filter-count');
    if (count) count.textContent = shown + ' shown';
  }

  if (search) search.addEventListener('input', apply);
  if (severity) severity.addEventListener('change', apply);
  apply();
})();
`;

export function renderLayout(options: LayoutOptions): string {
  const nav = options.nav
    .map(
      (link) =>
        `<a href="${escapeAttr(link.href)}"${link.current ? ' class="current"' : ''}>${escapeHtml(
          link.label,
        )}</a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="top">
  <h1>${escapeHtml(options.title)}</h1>
  ${options.subtitle ? `<p>${escapeHtml(options.subtitle)}</p>` : ''}
</header>
<nav class="tabs">${nav}</nav>
<main>${options.body}</main>
<footer>Generated by web-drifter. Screenshots are evidence, not detection: nothing is
reported because pixels differ.</footer>
<script>${FILTER_SCRIPT}${options.script ?? ''}</script>
</body>
</html>`;
}

/** The standard navigation, with `root` making it work from any depth. */
export function standardNav(root: string, current: string): NavLink[] {
  const links: Array<[string, string]> = [
    [`${root}index.html`, 'Overview'],
    [`${root}pages/index.html`, 'By page'],
    [`${root}css-report.html`, 'CSS'],
    [`${root}links-report.html`, 'Links'],
    [`${root}coverage-report.html`, 'Coverage'],
  ];
  return links.map(([href, label]) => ({ href, label, current: label === current }));
}

export function severityBadge(severity: Severity): string {
  return `<span class="badge ${severity}">${severity}</span>`;
}

/** Filter controls. Ids are wired to {@link FILTER_SCRIPT}. */
export function filterControls(): string {
  return `<div class="controls">
  <input id="filter-text" type="search" placeholder="Filter by page, element or text…" aria-label="Filter">
  <select id="filter-severity" aria-label="Severity">
    <option value="">All severities</option>
    <option value="error">Errors</option>
    <option value="warning">Warnings</option>
    <option value="info">Info</option>
  </select>
  <span id="filter-count" class="muted"></span>
</div>`;
}

export function emptyState(message: string): string {
  return `<div class="panel empty">${escapeHtml(message)}</div>`;
}
