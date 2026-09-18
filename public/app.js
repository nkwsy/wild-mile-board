"use strict";
/* The Wild Mile maintenance board.

   No framework and no build step, same as before: this file talks to the six
   /api endpoints and redraws. The only screen that gets special treatment is
   the report sheet, because the whole system is worthless if filing something
   from a phone on the boardwalk is slower than typing it into Slack. */

/* ============================ the words and the columns ============================ */

const STATUS = [
  { id: "new",       name: "New",                  step: "1" },
  { id: "triaged",   name: "Triaged",              step: "2" },
  { id: "scheduled", name: "Scheduled",            step: "3" },
  { id: "progress",  name: "In Progress",          step: "4" },
  { id: "done",      name: "Done",                 step: "5" },
  { id: "blocked",   name: "Blocked / Needs Info", step: "—", aside: true }
];
const STATUS_IDS = STATUS.map(s => s.id);
const statusName = id => (STATUS.find(s => s.id === id) || { name: id }).name;

const SEV_RANK = { "Urgent!": 0, "Important": 1, "Keep eyes on": 2 };
const sevClass = s => ({ "Urgent!": "sev-urgent", "Important": "sev-important" }[s] || "sev-eyes");

const EMPTY = {
  new: "Nothing new reported. Anything you saw today goes here.",
  triaged: "Nothing waiting on a decision.",
  scheduled: "Nothing on a work day yet.",
  progress: "Nobody out on a fix right now.",
  done: "Fixes land here once they're back in service.",
  blocked: "Nothing stalled. Park anything waiting on a part, a permit or an answer here."
};

const POLL_MS = 5000;
const REMEMBER_ME = "wildmile.me";

/* ============================ helpers ============================ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const say = m => { $("#live").textContent = m; };

/* A line at the bottom of the screen that fades. Errors used to be an alert(),
   which stops everything on a phone held in one hand over a river. */
let toastTimer = null;
function toast(message, trouble) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("bad", !!trouble);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, trouble ? 7000 : 3500);
  say(message);
}

const daysSince = iso => {
  const t = Date.parse(iso);
  return isNaN(t) ? 0 : Math.floor((Date.now() - t) / 86400000);
};
/* What the board says under a card. "today untouched" reads like nonsense. */
const untouchedFor = iso => {
  const d = daysSince(iso);
  return d < 1 ? "touched today" : d + (d === 1 ? " day untouched" : " days untouched");
};
const shortDate = iso => {
  const t = Date.parse(iso);
  return isNaN(t) ? "" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/* Whoever is using this phone. Asked once, remembered, never required. */
function me(value) {
  if (value !== undefined) {
    try { localStorage.setItem(REMEMBER_ME, value); } catch { /* private mode */ }
    state.me = value;
    return value;
  }
  if (state.me != null) return state.me;
  try { state.me = localStorage.getItem(REMEMBER_ME) || ""; } catch { state.me = ""; }
  return state.me;
}

/* ============================ state ============================ */

const state = {
  issues: [],
  meta: { locations: [], people: [], templates: [], severities: ["Urgent!", "Important", "Keep eyes on"],
          staleDays: 14, bulkCloseLimit: 3, photoStore: "pg", maxPhotoEdge: 1600 },
  view: "board",
  filters: { q: "", sevs: new Set(), loc: "", assignee: "", scope: "open", staleOnly: false },
  sort: { key: "touchedAt", dir: 1 },
  selected: new Set(),
  detail: null,
  me: null,
  online: false,
  inflight: 0,
  lastSig: ""
};

/* ============================ the API ============================ */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  const text = await res.text();
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  if (!res.ok) {
    const err = new Error((payload && payload.error) || "request failed (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* Every write goes through here. On failure it says what went wrong, forces the
   next poll to pull the server's version back, and returns undefined — so a
   caller writes `if (!out) return;` instead of wrapping itself in an empty
   catch. Every endpoint answers with a JSON object, so a truthy result means it
   went through. */
async function write(run, trouble) {
  state.inflight++;
  try {
    return await run();
  } catch (err) {
    state.lastSig = "";
    toast(trouble + " " + err.message, true);
    return undefined;
  } finally {
    state.inflight--;
  }
}

const listQuery = () => {
  const p = new URLSearchParams();
  if (state.filters.scope !== "open") p.set("scope", state.filters.scope);
  return p.toString() ? "?" + p.toString() : "";
};

/* The export mirrors what is on screen, filters and all. */
function exportHref() {
  const f = state.filters;
  const p = new URLSearchParams();
  p.set("scope", f.scope);
  if (f.q) p.set("q", f.q);
  if (f.sevs.size) p.set("severity", [...f.sevs].join(","));
  if (f.loc) p.set("location", f.loc);
  if (f.assignee) p.set("assignee", f.assignee);
  if (f.staleOnly) p.set("staleDays", state.meta.staleDays);
  return "/api/export?" + p.toString();
}

/* ============================ boot ============================ */

async function boot() {
  try {
    state.meta = { ...state.meta, ...(await api("GET", "/api/meta")) };
    await refresh(true);
    setOnline(true);
    setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  } catch (err) {
    setOnline(false, err.message);
  }
  drawFilters();
  drawSeverityPicks();
  render();
}

async function refresh(force) {
  const payload = await api("GET", "/api/issues" + listQuery());
  const sig = JSON.stringify(payload.issues);
  if (!force && sig === state.lastSig) return false;
  state.lastSig = sig;
  state.issues = payload.issues;
  return true;
}

/* Other people's changes. Anything the user has hold of right now — a card
   mid-drag, an open sheet, a write still in the air — means skip this tick
   rather than redraw underneath them. */
async function poll() {
  if (!state.online) return;
  if (drag || state.inflight) return;
  if ($$("dialog[open]").length || document.querySelector(".movemenu")) return;
  try {
    if (await refresh(false)) render();
  } catch { /* a blip; the next tick tries again */ }
}

function setOnline(on, why) {
  state.online = on;
  $("#modedot").classList.toggle("on", on);
  $("#modetext").textContent = on ? "Shared board" : "Not connected";
  $("#modenote").textContent = on
    ? "Everything here is saved for everyone who opens this page."
    : "Nothing you do will be saved.";
  $("#banner").hidden = on;
  $("#banner-why").textContent = why || "";
}

/* ============================ filters ============================ */

function drawFilters() {
  $("#sev-chips").innerHTML = state.meta.severities.map(s =>
    `<button type="button" class="chip-btn ${sevClass(s)}" data-sev="${esc(s)}" aria-pressed="false">${esc(s)}</button>`
  ).join("");

  const locs = state.meta.locations;
  $("#locsel").innerHTML = '<option value="">All locations</option>'
    + locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}${l.open ? " (" + l.open + ")" : ""}</option>`).join("");
  $("#loclist").innerHTML = locs.map(l => `<option value="${esc(l.name)}"></option>`).join("");
  $("#asgsel").innerHTML = '<option value="">Anyone</option>'
    + state.meta.people.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.open ? " (" + p.open + ")" : ""}</option>`).join("");
  $("#peoplelist").innerHTML = state.meta.people.map(p => `<option value="${esc(p.name)}"></option>`).join("");
}

function filtersActive() {
  const f = state.filters;
  return !!(f.q || f.sevs.size || f.loc || f.assignee || f.staleOnly);
}

function matches(i) {
  const f = state.filters;
  if (f.sevs.size && !f.sevs.has(i.severity)) return false;
  if (f.loc && i.locationId !== f.loc) return false;
  if (f.assignee && i.assignee.toLowerCase() !== f.assignee.toLowerCase()) return false;
  if (f.staleOnly && !isStale(i)) return false;
  if (f.q) {
    const hay = (i.title + " " + i.descr + " " + i.reporter + " " + i.location + " " + i.assignee).toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

const isStale = i => i.status !== "done" && daysSince(i.touchedAt) >= state.meta.staleDays;

function resetFilters() {
  state.filters = { q: "", sevs: new Set(), loc: "", assignee: "", scope: state.filters.scope, staleOnly: false };
  $("#q").value = ""; $("#locsel").value = ""; $("#asgsel").value = "";
  $$("#sev-chips [data-sev]").forEach(b => b.setAttribute("aria-pressed", "false"));
}

$("#sev-chips").addEventListener("click", e => {
  const b = e.target.closest("[data-sev]"); if (!b) return;
  const s = b.dataset.sev;
  state.filters.sevs.has(s) ? state.filters.sevs.delete(s) : state.filters.sevs.add(s);
  b.setAttribute("aria-pressed", state.filters.sevs.has(s) ? "true" : "false");
  render();
});
$("#q").addEventListener("input", e => { state.filters.q = e.target.value.trim().toLowerCase(); render(); });
$("#locsel").addEventListener("change", e => { state.filters.loc = e.target.value; render(); });
$("#asgsel").addEventListener("change", e => { state.filters.assignee = e.target.value; render(); });
$("#scopesel").addEventListener("change", async e => {
  state.filters.scope = e.target.value;
  if (state.online) { try { await refresh(true); } catch { /* the banner already says */ } }
  render();
});
$("#clearf").addEventListener("click", () => { resetFilters(); render(); });
$("#stale-show").addEventListener("click", () => {
  state.filters.staleOnly = !state.filters.staleOnly;
  setView("list");
  render();
});

$$(".views [data-view]").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
function setView(v) {
  state.view = v;
  $$(".views [data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  render();
}

/* ============================ render ============================ */

function visible() { return state.issues.filter(matches); }

function render() {
  $("#clearf").hidden = !filtersActive();
  $("#csv").href = exportHref();
  $("#scroller").hidden = state.view !== "board";
  $("#listview").hidden = state.view !== "list";
  $("#recurringview").hidden = state.view !== "recurring";

  renderTally();
  renderStale();
  renderBulkBar();
  if (state.view === "board") renderBoard();
  if (state.view === "list") renderList();
  if (state.view === "recurring") renderTemplates();
}

function renderTally() {
  const open = state.issues.filter(i => i.status !== "done");
  const hot = open.filter(i => i.severity === "Urgent!").length;
  const cold = state.issues.filter(isStale).length;
  $("#tally").innerHTML = `<b>${open.length}</b> open · <b>${hot}</b> urgent · <b>${cold}</b> untouched`;
}

function renderStale() {
  const stale = state.issues.filter(isStale);
  const strip = $("#stale");
  strip.hidden = stale.length === 0;
  if (!stale.length) return;
  const worst = Math.max(...stale.map(i => daysSince(i.touchedAt)));
  $("#stale-text").innerHTML = `<b>${stale.length} issue${stale.length === 1 ? "" : "s"}</b> nobody has touched in `
    + `${state.meta.staleDays} days — the oldest has sat for ${worst}.`;
  $("#stale-show").textContent = state.filters.staleOnly ? "Show everything" : "Show them";
}

/* ---------------- board ---------------- */

const GRIP = '<svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" focusable="false">'
  + [2, 7, 12].map(y => `<circle cx="2.5" cy="${y}" r="1.35" fill="currentColor"/><circle cx="7.5" cy="${y}" r="1.35" fill="currentColor"/>`).join("")
  + "</svg>";

function cardHTML(i) {
  const stale = isStale(i);
  const bits = [];
  if (i.assignee) {
    bits.push(`<span class="who">${esc(i.assignee)}${i.assignmentState === "accepted" ? " ✓" : ""}</span>`);
  } else if (i.reporter) {
    bits.push(`<span class="who">${esc(i.reporter)}</span>`);
  }
  if (i.status !== "done") {
    bits.push(`<span class="age${stale ? " old" : ""}">${esc(untouchedFor(i.touchedAt))}</span>`);
  } else if (i.closedAt) {
    bits.push(`<span class="age">closed ${esc(shortDate(i.closedAt))}</span>`);
  }
  const move = `<button type="button" class="mini" data-move aria-haspopup="true" aria-expanded="false"`
    + ` aria-label="Move ${esc(i.title)} to another column">Move ›</button>`;
  const thumbs = i.photoCount
    ? `<div class="thumbs" data-photos="${i.photoCount}">`
      + (i.firstPhoto
          ? `<img src="/api/photos?id=${encodeURIComponent(i.firstPhoto)}" alt="" loading="lazy">` : "")
      + (i.photoCount > 1 ? `<span class="pill">+${i.photoCount - 1}</span>` : "")
      + `</div>`
    : "";
  const due = i.dueOn
    ? `<span class="pill due" title="${esc(i.dueReason || "")}">by ${esc(shortDate(i.dueOn + "T12:00:00Z"))}</span>`
    : "";

  return `<article class="card${stale ? " stale-card" : ""}" tabindex="0" data-id="${esc(i.id)}"`
    + ` aria-label="${esc(i.title + ". " + i.severity + ", " + (i.location || "no location") + ", " + statusName(i.status))}">`
    + `<span class="grip" data-grip aria-hidden="true" title="Drag to another column">${GRIP}</span>`
    + `<h3 class="card-title">${esc(i.title)}</h3>`
    + `<div class="meta"><span class="schip ${sevClass(i.severity)}">${esc(i.severity)}</span>`
    + (i.location ? `<span class="loc">${esc(i.location)}</span>` : "") + due + `</div>`
    + thumbs
    + `<div class="byline">${bits.join("")}${move}</div>`
    + `</article>`;
}

function renderBoard() {
  const shown = visible();
  const board = $("#board");
  const active = document.activeElement;
  const keep = active && active.classList && active.classList.contains("card") ? active.dataset.id : null;

  board.innerHTML = STATUS.map(col => {
    const all = state.issues.filter(i => i.status === col.id);
    const here = shown.filter(i => i.status === col.id)
      .sort((a, b) => a.ord - b.ord || SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    const hidden = all.length - here.length;
    const badge = hidden
      ? `<span class="count filtered" title="${hidden} hidden by filters">${here.length}/${all.length}</span>`
      : `<span class="count">${all.length}</span>`;
    const body = here.length
      ? here.map(cardHTML).join("")
      : `<p class="empty">${all.length ? "Nothing here matches the filters." : EMPTY[col.id]}</p>`;
    return `<section class="col${col.aside ? " aside" : ""}" data-col="${col.id}" aria-label="${esc(col.name)}">`
      + `<div class="col-head"><span class="step">${esc(col.step)}</span>`
      + `<span class="col-name">${esc(col.name)}</span>${badge}</div>`
      + `<div class="col-body" data-body="${col.id}">${body}</div>`
      + `<div class="col-foot"><button type="button" class="addbtn" data-add="${col.id}">+ Report an issue</button></div>`
      + `</section>`;
  }).join("");

  if (keep) {
    const el = board.querySelector(`.card[data-id="${CSS.escape(keep)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}

/* ---------------- list ---------------- */

function renderList() {
  const rows = visible().sort(compare);
  const body = $("#listbody");
  body.innerHTML = rows.map(i => {
    const stale = isStale(i);
    const untouched = i.status === "done" ? "—" : untouchedFor(i.touchedAt);
    return `<tr data-id="${esc(i.id)}"${stale ? ' class="stale-row"' : ""}>`
      + `<td class="rowsel"><input type="checkbox" data-pick="${esc(i.id)}"`
      + `${state.selected.has(i.id) ? " checked" : ""} aria-label="Select ${esc(i.title)}"></td>`
      + `<td class="t">${esc(i.title)}`
      + (i.photoCount ? ` <span class="pill">${i.photoCount}📷</span>` : "")
      + (i.dueOn ? ` <span class="pill due">by ${esc(i.dueOn)}</span>` : "") + `</td>`
      + `<td><span class="schip ${sevClass(i.severity)}">${esc(i.severity)}</span></td>`
      + `<td>${esc(statusName(i.status))}</td>`
      + `<td>${esc(i.location || "—")}</td>`
      + `<td>${esc(i.assignee || "—")}${i.assignmentState === "accepted" ? " ✓" : ""}`
      + `${i.assignmentState === "declined" ? ' <span class="pill">declined</span>' : ""}</td>`
      + `<td class="num">${esc(i.dueOn || "—")}</td>`
      + `<td class="num${stale ? " old" : ""}">${esc(untouched)}</td>`
      + `</tr>`;
  }).join("");

  $("#listnote").textContent = rows.length
    ? `${rows.length} issue${rows.length === 1 ? "" : "s"}` + (filtersActive() ? " matching the filters" : "")
      + (state.filters.staleOnly ? " — only the ones nobody has touched" : "")
    : "Nothing matches.";
  $("#selall").checked = rows.length > 0 && rows.every(i => state.selected.has(i.id));

  $$("table.issues th[data-sort]").forEach(th => {
    if (th.dataset.sort === state.sort.key) th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
}

function compare(a, b) {
  const k = state.sort.key, d = state.sort.dir;
  // Whatever the sort, the stale ones come first: the backlog is the problem.
  if (isStale(a) !== isStale(b)) return isStale(a) ? -1 : 1;
  if (k === "severity") return (SEV_RANK[a.severity] - SEV_RANK[b.severity]) * d;
  if (k === "touchedAt") return (Date.parse(b.touchedAt) - Date.parse(a.touchedAt)) * d;
  const av = String(a[k] ?? ""), bv = String(b[k] ?? "");
  if (!av && bv) return 1;
  if (av && !bv) return -1;
  return av.localeCompare(bv) * d;
}

$$("table.issues th[data-sort]").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.sort;
  state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
  render();
}));

$("#listbody").addEventListener("click", e => {
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    e.stopPropagation();
    pick.checked ? state.selected.add(pick.dataset.pick) : state.selected.delete(pick.dataset.pick);
    renderBulkBar();
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openIssue(row.dataset.id);
});
$("#selall").addEventListener("change", e => {
  const rows = visible();
  rows.forEach(i => e.target.checked ? state.selected.add(i.id) : state.selected.delete(i.id));
  render();
});

function renderBulkBar() {
  let bar = $("#bulkbar");
  const n = state.selected.size;
  if (!n || state.view !== "list") { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "bulkbar";
    bar.className = "bulkbar";
    document.body.appendChild(bar);
    bar.addEventListener("click", e => {
      if (e.target.id === "bulk-open") openBulk();
      if (e.target.id === "bulk-none") { state.selected.clear(); render(); }
    });
  }
  bar.innerHTML = `<div class="wrap"><b>${n} selected</b>`
    + `<button type="button" class="btn primary" id="bulk-open">Close ${n === 1 ? "it" : "them"}</button>`
    + `<button type="button" class="btn" id="bulk-none">Clear</button>`
    + (n > state.meta.bulkCloseLimit
        ? `<span class="hint">More than ${state.meta.bulkCloseLimit} at once needs a reason.</span>` : "")
    + `</div>`;
}

/* ---------------- recurring inspections ---------------- */

function cadenceWords(t) {
  if (t.cadence === "on_dates") return "every year on " + (t.monthDays || "—");
  const season = t.seasonStart && t.seasonEnd ? `, ${t.seasonStart} to ${t.seasonEnd}` : " all year";
  return `every ${t.intervalDays} days${season}`;
}

function renderTemplates() {
  $("#tpl-grid").innerHTML = state.meta.templates.map(t =>
    `<article class="tpl${t.active ? "" : " off"}" data-tpl="${esc(t.id)}">`
    + `<h3>${esc(t.title)}</h3>`
    + `<p class="cadence">${esc(cadenceWords(t))}</p>`
    + (t.descr ? `<p>${esc(t.descr)}</p>` : "")
    + `<p class="hint">${esc(t.location || "anywhere")} · ${esc(t.severity)}`
    + (t.openInstances ? ` · ${t.openInstances} open` : "")
    + (t.nextDue ? ` · next ${esc(t.nextDue)}` : "") + `</p>`
    + `<div class="tpl-actions">`
    + `<button type="button" class="btn small" data-edit="${esc(t.id)}">Edit</button>`
    + `<button type="button" class="btn small" data-gen="${esc(t.id)}">Generate</button>`
    + `<button type="button" class="btn small" data-toggle="${esc(t.id)}">${t.active ? "Pause" : "Resume"}</button>`
    + `</div></article>`
  ).join("") || '<p class="empty">No recurring inspections yet.</p>';
}

$("#tpl-grid").addEventListener("click", async e => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return openTemplate(state.meta.templates.find(t => t.id === edit.dataset.edit));
  const gen = e.target.closest("[data-gen]");
  if (gen) return runGenerate(gen.dataset.gen);
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const t = state.meta.templates.find(x => x.id === toggle.dataset.toggle);
    const done = await write(() => api("PATCH", "/api/recurring?id=" + encodeURIComponent(t.id),
      { active: !t.active }), "Couldn't change that inspection.");
    if (!done) return;
    await reloadMeta();
    render();
  }
});

$("#gen-run").addEventListener("click", () => runGenerate(""));

async function runGenerate(templateId) {
  const out = await write(
    () => api("POST", "/api/recurring?do=generate", { templateId, days: 60, actor: me() }),
    "Couldn't generate the inspections.");
  if (!out) return;
  await Promise.all([reloadMeta(), refresh(true)]);
  render();
  const made = out.created.length;
  const words = made
    ? `${made} inspection${made === 1 ? "" : "s"} scheduled through ${out.to}.`
    : `Nothing new — the ${out.skipped} due before ${out.to} are already on the board.`;
  $("#gen-note").textContent = words;
  say(words);
}

async function reloadMeta() {
  try { state.meta = { ...state.meta, ...(await api("GET", "/api/meta")) }; drawFilters(); }
  catch { /* the lists stay as they were */ }
}

/* ============================ the report sheet ============================ */

const report = $("#report");
let shots = [];        // { dataUrl, name }

function openReport(presetStatus) {
  shots = [];
  $("#report-form").reset();
  $("#shots").innerHTML = "";
  $("#more").hidden = true;
  $("#more-toggle").setAttribute("aria-expanded", "false");
  $("#who").value = me();
  $("#report-hint").textContent = "";
  report.dataset.status = presetStatus || "new";
  drawWherePicks();
  drawSeverityPicks();
  report.showModal();
  $("#say").focus();
}

/* The six places with open issues, plus whatever this phone picked last time:
   one tap covers most reports, and the free-text box covers the rest. */
function drawWherePicks() {
  // Busiest places first, but never the catch-all: offering "Wild Mile
  // (unspecified)" as the easiest tap is how you get a board full of reports
  // that say nothing about where they are.
  const top = state.meta.locations
    .filter(l => l.kind !== "other")
    .sort((a, b) => (b.open || 0) - (a.open || 0))
    .slice(0, 6);
  $("#where-picks").innerHTML = top.map(l =>
    `<button type="button" class="pick" data-where="${esc(l.name)}" aria-pressed="false">${esc(l.name)}</button>`
  ).join("");
}
function drawSeverityPicks() {
  $("#sev-picks").innerHTML = state.meta.severities.map(s =>
    `<button type="button" class="pick ${sevClass(s)}" data-sev-pick="${esc(s)}"`
    + ` aria-pressed="${s === "Important"}">${esc(s)}</button>`).join("");
}
const severityOptions = chosen => state.meta.severities
  .map(s => `<option${s === chosen ? " selected" : ""}>${esc(s)}</option>`).join("");

$("#where-picks").addEventListener("click", e => {
  const b = e.target.closest("[data-where]"); if (!b) return;
  const on = b.getAttribute("aria-pressed") === "true";
  $$("#where-picks [data-where]").forEach(x => x.setAttribute("aria-pressed", "false"));
  b.setAttribute("aria-pressed", on ? "false" : "true");
  if (!on) $("#where-free").value = "";
});
$("#where-free").addEventListener("input", () => {
  $$("#where-picks [data-where]").forEach(x => x.setAttribute("aria-pressed", "false"));
});
$("#sev-picks").addEventListener("click", e => {
  const b = e.target.closest("[data-sev-pick]"); if (!b) return;
  $$("#sev-picks [data-sev-pick]").forEach(x => x.setAttribute("aria-pressed", "false"));
  b.setAttribute("aria-pressed", "true");
});
$("#more-toggle").addEventListener("click", () => {
  const more = $("#more");
  more.hidden = !more.hidden;
  $("#more-toggle").setAttribute("aria-expanded", String(!more.hidden));
});

$("#shot-btn").addEventListener("click", () => $("#shot-input").click());
$("#shot-input").addEventListener("change", async e => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) {
    try {
      shots.push({ dataUrl: await shrink(file), name: file.name });
    } catch (err) {
      $("#report-hint").textContent = "Couldn't read " + file.name + ": " + err.message;
    }
  }
  drawShots();
});

function drawShots() {
  $("#shots").innerHTML = shots.map((s, n) =>
    `<figure><img src="${s.dataUrl}" alt="${esc(s.name || "photo " + (n + 1))}">`
    + `<button type="button" data-drop="${n}" aria-label="Remove this photo">&times;</button></figure>`
  ).join("");
  $("#shot-label").textContent = shots.length ? "Another photo" : "Take a photo";
}
$("#shots").addEventListener("click", e => {
  const b = e.target.closest("[data-drop]"); if (!b) return;
  shots.splice(Number(b.dataset.drop), 1);
  drawShots();
});

/* A phone photo is 3-5 MB and 4000 pixels wide. Nobody needs that to see a
   cracked board, and on river wifi nobody would wait for it either. */
function shrink(file, maxEdge) {
  const edge = maxEdge || state.meta.maxPhotoEdge || 1600;
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error("that isn't an image"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, edge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      try { resolve(canvas.toDataURL("image/jpeg", 0.82)); }
      catch (err) { reject(err); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("that image wouldn't open")); };
    img.src = url;
  });
}

$("#report-form").addEventListener("submit", async e => {
  e.preventDefault();
  const sentence = $("#say").value.trim();
  if (!sentence) { $("#say").focus(); return; }

  const picked = $("#where-picks [aria-pressed='true']");
  const where = $("#where-free").value.trim() || (picked ? picked.dataset.where : "");
  const sevBtn = $("#sev-picks [aria-pressed='true']");
  const severity = sevBtn ? sevBtn.dataset.sevPick : "Important";
  const who = $("#who").value.trim();
  if (who) me(who);

  const send = $("#report-send");
  send.disabled = true;
  send.textContent = "Sending…";
  try {
    const filed = await write(() => api("POST", "/api/issues", {
      title: sentence,
      descr: $("#detail").value.trim(),
      location: where,
      severity,
      reporter: who,
      status: report.dataset.status || "new",
      dueOn: $("#due").value || undefined,
      dueReason: $("#due-why").value.trim() || undefined,
      actor: who
    }), "Couldn't file that.");
    if (!filed) return;
    const issue = filed.issue;

    for (const shot of shots) {
      await write(() => api("POST", "/api/photos?issue=" + encodeURIComponent(issue.id),
        { dataUrl: shot.dataUrl, actor: who }), "The issue was filed but a photo didn't attach.");
    }

    report.close();
    // A new issue that the filters would hide vanishes on the spot, which is
    // the bug the newest person on the team hit on day one. Clear them.
    const wasFiltered = filtersActive() && !matches(issue);
    if (wasFiltered) resetFilters();
    await Promise.all([refresh(true), reloadMeta()]);
    render();
    spotlight(issue.id);
    say(`Filed "${issue.title}"${shots.length ? " with " + shots.length + " photo(s)" : ""}.`
      + (wasFiltered ? " Filters cleared so you can see it." : ""));
  } finally {
    send.disabled = false;
    send.textContent = "Send it";
  }
});

$("#report-open").addEventListener("click", () => openReport("new"));
$("#fab").addEventListener("click", () => openReport("new"));
$("#report-close").addEventListener("click", () => report.close());

function spotlight(id) {
  const el = $("#board").querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.add("justadded");
  try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); }
  catch { el.scrollIntoView(); }
  setTimeout(() => el.classList.remove("justadded"), 2200);
}

/* ============================ the issue panel ============================ */

const drawer = $("#drawer");

async function openIssue(id) {
  closeMoveMenu();
  const out = await write(() => api("GET", "/api/issues?id=" + encodeURIComponent(id)),
    "Couldn't open that issue.");
  if (!out) return;
  state.detail = out.issue;
  drawIssue();
  if (!drawer.open) drawer.showModal();
}

function drawIssue() {
  const i = state.detail;
  if (!i) return;
  $("#dtitle").textContent = i.status === "done" ? "Closed issue" : "Issue";

  const people = state.meta.people.map(p =>
    `<option value="${esc(p.name)}"${p.name === i.assignee ? " selected" : ""}>${esc(p.name)}</option>`).join("");

  $("#dbody").innerHTML = `
    <div class="f">
      <label for="e-title">What's wrong</label>
      <input type="text" id="e-title" maxlength="160" value="${esc(i.title)}">
    </div>
    <div class="f2">
      <div class="f">
        <label for="e-sev">Severity</label>
        <select id="e-sev">${severityOptions(i.severity)}</select>
      </div>
      <div class="f">
        <label for="e-status">Column</label>
        <select id="e-status">${STATUS.map(s =>
          `<option value="${s.id}"${s.id === i.status ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="f">
      <label for="e-loc">Where</label>
      <input type="text" id="e-loc" maxlength="160" list="loclist" value="${esc(i.location)}">
      <p class="hint">${i.locationId ? "Filed under " + esc(locName(i.locationId)) : "Free text — no location record matched."}</p>
    </div>
    <div class="f">
      <label for="e-descr">Detail</label>
      <textarea id="e-descr" maxlength="4000">${esc(i.descr)}</textarea>
    </div>
    <div class="f2">
      <div class="f">
        <label for="e-due">Needed by</label>
        <input type="date" id="e-due" value="${esc(i.dueOn || "")}">
      </div>
      <div class="f">
        <label for="e-due-why">Because</label>
        <input type="text" id="e-due-why" maxlength="200" value="${esc(i.dueReason)}">
      </div>
    </div>

    <div class="sect">
      <h3>Who has it</h3>
      <div class="assignrow">
        <select id="e-assignee">
          <option value="">Nobody yet</option>${people}
        </select>
        <button type="button" class="btn small" id="do-assign">Assign</button>
      </div>
      ${i.assignee ? `<div class="assignrow">
        <span class="hint">${esc(i.assignee)} — ${esc(i.assignmentState)}</span>
        <button type="button" class="btn small" id="do-accept">Accept</button>
        <button type="button" class="btn small" id="do-decline">Decline</button>
      </div>` : '<p class="hint">Nobody has taken this on. That is how the last three trackers died.</p>'}
    </div>

    <div class="sect">
      <h3>Photos${i.photos.length ? " (" + i.photos.length + ")" : ""}</h3>
      <div class="gallery">${i.photos.map(p =>
        `<a href="${esc(p.src)}" target="_blank" rel="noopener noreferrer"
            class="${p.kind === "after" ? "after" : ""}" title="${esc(p.kind === "after" ? "after the fix" : p.caption || "")}">
           <img src="${esc(p.src)}" alt="${esc(p.caption || (p.kind === "after" ? "after the fix" : "reported photo"))}"></a>`
      ).join("") || '<p class="hint">No photos. A photo is usually the whole report.</p>'}</div>
      <input type="file" id="add-photo-input" accept="image/*" capture="environment" multiple hidden>
      <button type="button" class="btn small" id="add-photo">+ Add a photo</button>
    </div>

    ${i.status === "done" ? closeoutHTML(i) : ""}

    <div class="sect">
      <h3>History</h3>
      <ul class="hist">${i.history.map(h =>
        `<li><time datetime="${esc(h.at)}">${esc(shortDate(h.at))}</time>`
        + `<span class="what"><span class="k ${esc(h.kind)}">${esc(h.kind)}</span>`
        + `${esc(h.body)}${h.actor ? " — <b>" + esc(h.actor) + "</b>" : ""}</span></li>`
      ).join("")}</ul>
      <div class="f">
        <label for="e-note">Add a note</label>
        <textarea id="e-note" maxlength="600" placeholder="What you saw, what you tried, what it still needs"></textarea>
      </div>
      <button type="button" class="btn small" id="do-note">Add note</button>
    </div>`;

  $("#dfoot").innerHTML = (i.status === "done"
      ? `<button type="button" class="btn" id="do-reopen">Reopen</button>`
      : `<button type="button" class="btn primary" id="do-close">Close it</button>`)
    + `<button type="button" class="btn" id="do-save">Save changes</button>`
    + `<button type="button" class="btn danger" id="do-delete" style="margin-left:auto">Delete</button>`;
}

const locName = id => (state.meta.locations.find(l => l.id === id) || { name: id }).name;

/* The questions the old close-out form asked, asked after the fact and never in
   the way of the close. Blank is a perfectly good answer. */
function closeoutHTML(i) {
  return `<div class="sect">
    <h3>Close-out — all optional</h3>
    <p class="hint">Closed ${esc(shortDate(i.closedAt))}${i.closedBy ? " by " + esc(i.closedBy) : ""}.
      ${esc(i.closeNote || "")}</p>
    <div class="f">
      <label for="e-cause">What caused it, as best you understand</label>
      <textarea id="e-cause" maxlength="1000">${esc(i.closeCause)}</textarea>
    </div>
    <div class="f2">
      <div class="f">
        <label for="e-conf">How sure are you (1–7)</label>
        <input type="number" id="e-conf" min="1" max="7" value="${esc(i.closeConfidence == null ? "" : i.closeConfidence)}">
      </div>
      <div class="f">
        <label for="e-review">Should anyone check it</label>
        <input type="text" id="e-review" maxlength="200" list="peoplelist" value="${esc(i.closeReview)}">
      </div>
    </div>
  </div>`;
}

$("#dbody").addEventListener("click", async e => {
  const i = state.detail;
  if (!i) return;
  const id = e.target.id;

  if (id === "do-assign") {
    const assignee = $("#e-assignee").value;
    await act(() => api("POST", "/api/actions", { action: "assign", id: i.id, assignee, actor: me() }));
  }
  if (id === "do-accept" || id === "do-decline") {
    const action = id === "do-accept" ? "accept" : "decline";
    if (action === "accept" && !me()) me(i.assignee);
    await act(() => api("POST", "/api/actions", { action, id: i.id, actor: me() || i.assignee }));
  }
  if (id === "do-note") {
    const body = $("#e-note").value.trim();
    if (!body) return;
    await act(() => api("POST", "/api/actions", { action: "note", id: i.id, body, actor: me() }));
  }
  if (id === "add-photo") $("#add-photo-input").click();
});

$("#dbody").addEventListener("change", async e => {
  if (e.target.id !== "add-photo-input") return;
  const i = state.detail;
  const files = [...e.target.files];
  e.target.value = "";
  const kind = i.status === "done" ? "after" : "photo";
  for (const file of files) {
    let dataUrl;
    try { dataUrl = await shrink(file); }
    catch (err) { toast("Couldn't read that image. " + err.message, true); continue; }
    await write(() => api("POST", "/api/photos?issue=" + encodeURIComponent(i.id),
      { dataUrl, kind, actor: me() }), "That photo didn't attach.");
  }
  await act(() => api("GET", "/api/issues?id=" + encodeURIComponent(i.id)));
});

/* Runs an action, then reloads the issue and the board around it. */
async function act(run) {
  const out = await write(run, "That didn't go through.");
  if (!out) return;
  const fresh = out.issue
    || (await write(() => api("GET", "/api/issues?id=" + encodeURIComponent(state.detail.id)),
                    "Couldn't reload that issue.") || {}).issue;
  if (!fresh) return;
  state.detail = fresh;
  drawIssue();
  await refresh(true);
  render();
}

$("#dfoot").addEventListener("click", async e => {
  const i = state.detail;
  if (!i) return;

  if (e.target.id === "do-save") {
    const patch = {
      title: $("#e-title").value.trim(),
      descr: $("#e-descr").value.trim(),
      severity: $("#e-sev").value,
      status: $("#e-status").value,
      location: $("#e-loc").value.trim(),
      dueOn: $("#e-due").value,
      dueReason: $("#e-due-why").value.trim(),
      actor: me()
    };
    if ($("#e-cause")) {
      patch.closeCause = $("#e-cause").value.trim();
      patch.closeConfidence = $("#e-conf").value === "" ? null : Number($("#e-conf").value);
      patch.closeReview = $("#e-review").value.trim();
    }
    await act(() => api("PATCH", "/api/issues?id=" + encodeURIComponent(i.id), patch));
    say("Saved.");
  }

  if (e.target.id === "do-close") {
    await act(() => api("POST", "/api/actions",
      { action: "close", id: i.id, actor: me(), note: $("#e-note") ? $("#e-note").value.trim() : "" }));
    say("Closed. Add an after photo if you have one — everything else is optional.");
  }

  if (e.target.id === "do-reopen") {
    await act(() => api("POST", "/api/actions", { action: "reopen", id: i.id, actor: me() }));
  }

  if (e.target.id === "do-delete") {
    if (!confirm(`Delete "${i.title}" and its photos and history for good?`)) return;
    const gone = await write(() => api("DELETE", "/api/issues?id=" + encodeURIComponent(i.id)),
      "Couldn't delete that.");
    if (!gone) return;
    drawer.close();
    state.detail = null;
    await refresh(true);
    render();
  }
});

$("#dclose").addEventListener("click", () => drawer.close());
drawer.addEventListener("close", () => { state.detail = null; });
drawer.addEventListener("click", e => { if (e.target === drawer) drawer.close(); });

/* ============================ closing a pile ============================ */

const bulk = $("#bulk");

function openBulk() {
  const picked = state.issues.filter(i => state.selected.has(i.id) && i.status !== "done");
  const needsReason = picked.length > state.meta.bulkCloseLimit;
  $("#bulk-what").textContent = picked.length === 1
    ? `Closing "${picked[0].title}".`
    : `Closing ${picked.length} issues: ` + picked.slice(0, 4).map(i => i.title).join("; ")
      + (picked.length > 4 ? ` and ${picked.length - 4} more.` : ".");
  $("#bulk-hint").textContent = needsReason
    ? `More than ${state.meta.bulkCloseLimit} at once, so the reason goes on every one of their histories.`
    : "Optional.";
  $("#bulk-reason").required = needsReason;
  $("#bulk-actor").value = me();
  bulk.showModal();
}

$("#bulk-form").addEventListener("submit", async e => {
  e.preventDefault();
  const ids = [...state.selected];
  const actor = $("#bulk-actor").value.trim();
  if (actor) me(actor);
  const out = await write(() => api("POST", "/api/actions", {
    action: "close", ids, actor, reason: $("#bulk-reason").value.trim()
  }), "Couldn't close those.");
  if (!out) return;
  bulk.close();
  state.selected.clear();
  await refresh(true);
  render();
  say(`Closed ${out.closed.length}.`);
});
$("#bulk-cancel").addEventListener("click", () => bulk.close());
$("#bulk-close").addEventListener("click", () => bulk.close());

/* ============================ the inspection editor ============================ */

const tplDialog = $("#tpl");
let editingTemplate = null;

function openTemplate(t) {
  editingTemplate = t || null;
  $("#tpl-sev").innerHTML = severityOptions(t ? t.severity : "Keep eyes on");
  $("#tpl-title").textContent = t ? "Edit inspection" : "New recurring inspection";
  $("#tpl-name").value = t ? t.title : "";
  $("#tpl-descr").value = t ? t.descr : "";
  $("#tpl-loc").value = t ? t.location : "";
  $("#tpl-sev").value = t ? t.severity : "Keep eyes on";
  $("#tpl-cadence").value = t ? t.cadence : "every_days";
  $("#tpl-interval").value = t && t.intervalDays ? t.intervalDays : 14;
  $("#tpl-season-start").value = t ? t.seasonStart : "";
  $("#tpl-season-end").value = t ? t.seasonEnd : "";
  $("#tpl-monthdays").value = t ? t.monthDays : "";
  $("#tpl-delete").hidden = !t;
  $("#tpl-hint").textContent = "";
  syncCadence();
  tplDialog.showModal();
  $("#tpl-name").focus();
}

function syncCadence() {
  const onDates = $("#tpl-cadence").value === "on_dates";
  $("#tpl-every").hidden = onDates;
  $("#tpl-dates").hidden = !onDates;
}
$("#tpl-cadence").addEventListener("change", syncCadence);
$("#tpl-new").addEventListener("click", () => openTemplate(null));
$("#tpl-close").addEventListener("click", () => tplDialog.close());

$("#tpl-form").addEventListener("submit", async e => {
  e.preventDefault();
  const payload = {
    title: $("#tpl-name").value.trim(),
    descr: $("#tpl-descr").value.trim(),
    location: $("#tpl-loc").value.trim(),
    severity: $("#tpl-sev").value,
    cadence: $("#tpl-cadence").value,
    intervalDays: Number($("#tpl-interval").value),
    seasonStart: $("#tpl-season-start").value.trim(),
    seasonEnd: $("#tpl-season-end").value.trim(),
    monthDays: $("#tpl-monthdays").value.trim()
  };
  const saved = editingTemplate
    ? await write(() => api("PATCH", "/api/recurring?id=" + encodeURIComponent(editingTemplate.id), payload),
        "Couldn't save that inspection.")
    : await write(() => api("POST", "/api/recurring", payload), "Couldn't create that inspection.");
  if (!saved) return;
  tplDialog.close();
  await reloadMeta();
  render();
  say("Inspection saved.");
});

$("#tpl-delete").addEventListener("click", async () => {
  if (!editingTemplate || !confirm(`Stop generating "${editingTemplate.title}"? Issues it already made stay.`)) return;
  const gone = await write(() => api("DELETE", "/api/recurring?id=" + encodeURIComponent(editingTemplate.id)),
    "Couldn't delete that inspection.");
  if (!gone) return;
  tplDialog.close();
  await reloadMeta();
  render();
});

/* ============================ board interaction ============================ */

const board = $("#board");

board.addEventListener("click", e => {
  const add = e.target.closest("[data-add]");
  if (add) return openReport(add.dataset.add);
  const mv = e.target.closest("[data-move]");
  if (mv) { e.stopPropagation(); return toggleMoveMenu(mv.closest(".card")); }
  if (e.target.closest(".movemenu") || e.target.closest("a") || e.target.closest(".grip")) return;
  const card = e.target.closest(".card");
  if (card && !dragMoved) openIssue(card.dataset.id);
});

board.addEventListener("keydown", e => {
  const card = e.target.closest(".card");
  if (!card) return;
  const issue = state.issues.find(i => i.id === card.dataset.id);
  if (!issue) return;
  if (e.key === "Enter" || e.key === " ") {
    if (e.target !== card) return;
    e.preventDefault();
    return openIssue(issue.id);
  }
  if (!(e.ctrlKey || e.metaKey)) return;
  const at = STATUS_IDS.indexOf(issue.status);
  if (e.key === "ArrowRight" && at < STATUS_IDS.length - 1) { e.preventDefault(); moveTo(issue, STATUS_IDS[at + 1]); }
  if (e.key === "ArrowLeft" && at > 0) { e.preventDefault(); moveTo(issue, STATUS_IDS[at - 1]); }
});

document.addEventListener("click", e => {
  if (!e.target.closest(".movemenu") && !e.target.closest("[data-move]")) closeMoveMenu();
});

function closeMoveMenu() {
  $$(".movemenu").forEach(m => m.remove());
  $$("[data-move]").forEach(b => b.setAttribute("aria-expanded", "false"));
}

function toggleMoveMenu(card) {
  const already = card.querySelector(".movemenu");
  closeMoveMenu();
  if (already) return;
  const issue = state.issues.find(i => i.id === card.dataset.id);
  if (!issue) return;
  const menu = document.createElement("div");
  menu.className = "movemenu";
  menu.innerHTML = '<span class="mm-lbl">Move to</span>' + STATUS.map(s =>
    `<button type="button" data-to="${s.id}"${s.id === issue.status ? " disabled" : ""}>`
    + `${esc(s.name)}${s.id === issue.status ? " · here now" : ""}</button>`).join("");
  card.appendChild(menu);
  card.querySelector("[data-move]").setAttribute("aria-expanded", "true");
  menu.addEventListener("click", ev => {
    const b = ev.target.closest("[data-to]");
    if (!b || b.disabled) return;
    ev.stopPropagation();
    closeMoveMenu();
    moveTo(issue, b.dataset.to);
  });
  const first = menu.querySelector("button:not(:disabled)");
  if (first) first.focus();
  menu.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { ev.stopPropagation(); closeMoveMenu(); card.focus(); }
  });
}

async function moveTo(issue, status, ord) {
  if (issue.status === status && ord === undefined) return;
  const patch = { status, actor: me() };
  if (ord !== undefined) patch.ord = ord;
  // Show it moved before the round trip; a failure drops lastSig and the next
  // poll puts it back where the server says it is.
  issue.status = status;
  if (ord !== undefined) issue.ord = ord;
  render();
  const moved = await write(() => api("PATCH", "/api/issues?id=" + encodeURIComponent(issue.id), patch),
    "Couldn't move that.");
  if (!moved) return;
  await refresh(true);
  render();
  say(`${issue.title} moved to ${statusName(status)}.`);
}

/* ---------------- pointer drag (mouse anywhere, touch from the grip) ------- */

let drag = null, dragMoved = false;

board.addEventListener("pointerdown", e => {
  if (e.button != null && e.button !== 0) return;
  const card = e.target.closest(".card");
  if (!card || e.target.closest("a") || e.target.closest("button")) return;
  const fromGrip = !!e.target.closest("[data-grip]");
  if (e.pointerType !== "mouse" && !fromGrip) return;      // let touch scroll the column
  dragMoved = false;
  drag = { card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, started: false, pid: e.pointerId };
  card.setPointerCapture(e.pointerId);
});
board.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.pid) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    startDrag(e);
  }
  moveDrag(e);
});
["pointerup", "pointercancel"].forEach(t => board.addEventListener(t, e => {
  if (!drag || e.pointerId !== drag.pid) return;
  if (drag.started) endDrag(); else drag = null;
}));

function startDrag(e) {
  closeMoveMenu();
  const r = drag.card.getBoundingClientRect();
  drag.started = true; dragMoved = true;
  drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
  const ghost = drag.card.cloneNode(true);
  ghost.classList.add("ghost");
  ghost.style.width = r.width + "px";
  ghost.removeAttribute("tabindex");
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  const ph = document.createElement("div");
  ph.className = "placeholder";
  ph.style.height = r.height + "px";
  drag.ph = ph;
  drag.card.classList.add("dragging");
  drag.card.after(ph);
  document.body.style.userSelect = "none";
}

function moveDrag(e) {
  drag.ghost.style.left = (e.clientX - drag.dx) + "px";
  drag.ghost.style.top = (e.clientY - drag.dy) + "px";
  drag.ghost.style.display = "none";
  const under = document.elementFromPoint(e.clientX, e.clientY);
  drag.ghost.style.display = "";
  const body = under && under.closest ? under.closest(".col-body") : null;
  $$(".col-body.dropping").forEach(b => b.classList.remove("dropping"));
  if (!body) return;
  body.classList.add("dropping");
  let ref = null;
  for (const kid of body.querySelectorAll(".card:not(.dragging)")) {
    const r = kid.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { ref = kid; break; }
  }
  const note = body.querySelector(".empty");
  if (note) note.remove();
  if (ref) body.insertBefore(drag.ph, ref); else body.appendChild(drag.ph);
  autoScroll(e.clientX);
}

function autoScroll(x) {
  const sc = $("#scroller"), r = sc.getBoundingClientRect(), edge = 70;
  if (x < r.left + edge) sc.scrollLeft -= 16;
  else if (x > r.right - edge) sc.scrollLeft += 16;
}

function endDrag() {
  const ph = drag.ph;
  const body = ph.closest(".col-body");
  $$(".col-body.dropping").forEach(b => b.classList.remove("dropping"));
  drag.ghost.remove();
  drag.card.classList.remove("dragging");
  document.body.style.userSelect = "";
  const issue = state.issues.find(i => i.id === drag.id);
  if (!body || !issue) { ph.remove(); drag = null; setTimeout(() => { dragMoved = false; }, 0); return; }

  const status = body.dataset.body;
  const sibs = [...body.children].filter(n => n.classList.contains("card") || n === ph);
  const at = sibs.indexOf(ph);
  const around = sibs.filter(n => n !== ph)
    .map(n => state.issues.find(i => i.id === n.dataset.id)).filter(Boolean);
  const before = at > 0 ? around[at - 1] : null;
  const after = at < around.length ? around[at] : null;
  let ord;
  if (!before && !after) ord = 1000;
  else if (!before) ord = after.ord - 1000;
  else if (!after) ord = before.ord + 1000;
  else ord = (before.ord + after.ord) / 2;
  ph.remove();
  drag = null;
  setTimeout(() => { dragMoved = false; }, 0);
  moveTo(issue, status, ord);
}

/* ============================ go ============================ */

boot();
