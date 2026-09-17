"use strict";
/* Every read and write of an issue, its history and its people.

   Two rules run through all of it. Nothing changes an issue without also
   writing a history row — the board's whole reason for existing is that the
   story of a repair used to live in chat and then evaporate. And `touched_at`
   moves whenever a person does something, which is what the ageing view reads,
   so an issue that is being worked never looks stale and one that is being
   ignored always does. */

const { run, tx, init, resolveLocation } = require("./db");
const {
  SEVERITIES, DEFAULT_SEVERITY, STATUSES, ASSIGNMENT_STATES, ACTIVITY_KINDS,
  BULK_CLOSE_LIMIT
} = require("./vocab");

const bad = (status, message) => Object.assign(new Error(message), { status });
const str = v => (v == null ? "" : String(v));
const trim = (v, n) => str(v).trim().slice(0, n);
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const dateOrNull = v => (isDate(v) ? str(v) : null);

const newId = prefix =>
  prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const COLS = `i.id, i.title, i.descr, i.severity, i.status, i.location_id, i.location_text,
  i.reporter, i.assignee, i.assignment_state, i.reported_on, i.due_on, i.due_reason,
  i.source_link, i.template_id, i.ord, i.created_at, i.updated_at, i.touched_at,
  i.closed_at, i.closed_by, i.close_note, i.close_cause, i.close_confidence, i.close_review,
  (SELECT count(*) FROM attachments a WHERE a.issue_id = i.id)::int AS photo_count,
  (SELECT a.id FROM attachments a WHERE a.issue_id = i.id
    ORDER BY a.created_at, a.id LIMIT 1) AS first_photo`;

const iso = v => (v instanceof Date ? v.toISOString() : v);

const toIssue = r => ({
  id: r.id,
  title: r.title,
  descr: r.descr,
  severity: r.severity,
  status: r.status,
  locationId: r.location_id,
  location: r.location_text,
  reporter: r.reporter,
  assignee: r.assignee,
  assignmentState: r.assignment_state,
  reportedOn: r.reported_on,
  dueOn: r.due_on,
  dueReason: r.due_reason,
  sourceLink: r.source_link,
  templateId: r.template_id,
  ord: Number(r.ord),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  touchedAt: iso(r.touched_at),
  closedAt: iso(r.closed_at),
  closedBy: r.closed_by,
  closeNote: r.close_note,
  closeCause: r.close_cause,
  closeConfidence: r.close_confidence,
  closeReview: r.close_review,
  photoCount: r.photo_count || 0,
  firstPhoto: r.first_photo || null
});

const toEvent = r => ({
  id: Number(r.id),
  issueId: r.issue_id,
  kind: r.kind,
  actor: r.actor,
  body: r.body,
  meta: r.meta || {},
  at: iso(r.created_at)
});

/* ------------------------------ history ------------------------------ */

/* One history row, plus the touch that keeps the ageing view honest. `q` is
   whichever query function the caller is inside — the pool or a transaction. */
async function log(q, issueId, kind, actor, body, meta) {
  if (!ACTIVITY_KINDS.includes(kind)) throw new Error("unknown activity kind: " + kind);
  await q(`INSERT INTO activity (issue_id, kind, actor, body, meta) VALUES ($1,$2,$3,$4,$5)`,
    [issueId, kind, trim(actor, 80), trim(body, 600), JSON.stringify(meta || {})]);
  await q(`UPDATE issues SET touched_at = now() WHERE id = $1`, [issueId]);
}

async function history(issueId) {
  await init();
  const { rows } = await run(
    `SELECT id, issue_id, kind, actor, body, meta, created_at
       FROM activity WHERE issue_id = $1 ORDER BY id`, [issueId]);
  return rows.map(toEvent);
}

/* ------------------------------ filters ------------------------------ */

/* Builds the WHERE clause shared by the list endpoint and the CSV export, so
   "export what I am looking at" means exactly that. */
function where(f = {}) {
  const parts = [];
  const params = [];
  const add = (sql, value) => { params.push(value); parts.push(sql.replace("$?", "$" + params.length)); };

  const scope = f.scope === "all" || f.scope === "closed" ? f.scope : "open";
  if (scope === "open") parts.push("i.status <> 'done'");
  if (scope === "closed") parts.push("i.status = 'done'");

  const statuses = list(f.status).filter(s => STATUSES.includes(s));
  if (statuses.length) add("i.status = ANY($?)", statuses);

  const sevs = list(f.severity).filter(s => SEVERITIES.includes(s));
  if (sevs.length) add("i.severity = ANY($?)", sevs);

  if (str(f.location).trim()) {
    params.push(str(f.location).trim());
    parts.push(`(i.location_id = $${params.length} OR lower(i.location_text) = lower($${params.length}))`);
  }
  if (str(f.assignee).trim()) add("lower(i.assignee) = lower($?)", str(f.assignee).trim());
  if (str(f.template).trim()) add("i.template_id = $?", str(f.template).trim());

  if (str(f.q).trim()) {
    params.push("%" + str(f.q).trim().toLowerCase() + "%");
    const p = "$" + params.length;
    parts.push(`(lower(i.title) LIKE ${p} OR lower(i.descr) LIKE ${p} OR lower(i.location_text) LIKE ${p}
                 OR lower(i.reporter) LIKE ${p} OR lower(i.assignee) LIKE ${p})`);
  }
  if (f.staleDays) {
    params.push(Number(f.staleDays));
    parts.push(`i.status <> 'done' AND i.touched_at < now() - make_interval(days => $${params.length}::int)`);
  }
  return { sql: parts.length ? "WHERE " + parts.join(" AND ") : "", params };
}

const list = v => (Array.isArray(v) ? v : str(v).split(",")).map(s => str(s).trim()).filter(Boolean);

/* The same filters, read off a URL. The list endpoint and the CSV export both
   parse their query string this way, so an export matches what is on screen. */
const filtersFromQuery = q => ({
  q: q.get("q") || "",
  scope: q.get("scope") || "open",
  status: q.get("status") || "",
  severity: q.get("severity") || "",
  location: q.get("location") || "",
  assignee: q.get("assignee") || "",
  template: q.get("template") || "",
  staleDays: q.get("staleDays") || 0,
  limit: q.get("limit") || 0
});

/* ------------------------------ reads ------------------------------ */

async function listIssues(filters = {}) {
  await init();
  const { sql, params } = where(filters);
  const limit = Math.min(Math.max(Number(filters.limit) || 1000, 1), 5000);
  const { rows } = await run(
    `SELECT ${COLS} FROM issues i ${sql}
     ORDER BY i.status, i.ord, i.created_at
     LIMIT ${limit}`, params);
  return rows.map(toIssue);
}

async function getIssue(id) {
  await init();
  const { rows } = await run(`SELECT ${COLS} FROM issues i WHERE i.id = $1`, [str(id)]);
  if (!rows.length) return null;
  const issue = toIssue(rows[0]);
  const [{ rows: photos }, events] = await Promise.all([
    run(`SELECT id, kind, mime, bytes, caption, created_by, created_at
           FROM attachments WHERE issue_id = $1 ORDER BY created_at, id`, [issue.id]),
    history(issue.id)
  ]);
  issue.photos = photos.map(p => ({
    id: p.id, kind: p.kind, mime: p.mime, bytes: p.bytes,
    caption: p.caption, by: p.created_by, at: iso(p.created_at),
    src: "/api/photos?id=" + encodeURIComponent(p.id)
  }));
  issue.history = events;
  return issue;
}

async function nextOrd(status) {
  const { rows: [r] } = await run(
    `SELECT coalesce(max(ord), 0) + 1000 AS n FROM issues WHERE status = $1`, [status]);
  return Number(r.n);
}

/* ------------------------------ writes ------------------------------ */

/* The shape a report can set. Everything but the title is optional — the whole
   point of the phone flow is that a photo and one sentence is a complete
   report, and the rest gets asked for later if anyone cares. */
async function cleanInput(input, existing) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(input, k);

  if (has("title")) out.title = trim(input.title, 160) || "Untitled issue";
  if (has("descr")) out.descr = trim(input.descr, 4000);
  if (has("severity")) out.severity = SEVERITIES.includes(input.severity) ? input.severity : DEFAULT_SEVERITY;
  if (has("status")) out.status = STATUSES.includes(input.status) ? input.status : "new";
  if (has("reporter")) out.reporter = trim(input.reporter, 80);
  if (has("assignee")) out.assignee = trim(input.assignee, 80);
  if (has("reportedOn")) out.reported_on = dateOrNull(input.reportedOn);
  if (has("dueOn")) out.due_on = dateOrNull(input.dueOn);
  if (has("dueReason")) out.due_reason = trim(input.dueReason, 200);
  if (has("sourceLink")) out.source_link = trim(input.sourceLink, 500);
  if (has("closeCause")) out.close_cause = trim(input.closeCause, 1000);
  if (has("closeReview")) out.close_review = trim(input.closeReview, 200);
  if (has("closeNote")) out.close_note = trim(input.closeNote, 1000);
  if (has("closeConfidence")) {
    const n = Number(input.closeConfidence);
    out.close_confidence = Number.isFinite(n) && n >= 1 && n <= 7 ? Math.round(n) : null;
  }
  if (has("ord")) {
    const n = Number(input.ord);
    if (Number.isFinite(n)) out.ord = n;
  }
  if (has("location")) {
    out.location_text = trim(input.location, 160);
    out.location_id = out.location_text ? await resolveLocation(out.location_text) : null;
  }
  if (has("locationId") && !has("location")) {
    const id = trim(input.locationId, 80);
    out.location_id = id || null;
    if (id) {
      const { rows } = await run("SELECT name FROM locations WHERE id = $1", [id]);
      if (rows.length) out.location_text = rows[0].name;
      else out.location_id = existing ? existing.locationId : null;
    }
  }
  return out;
}

async function createIssue(input, actor) {
  await init();
  const fields = await cleanInput({ severity: DEFAULT_SEVERITY, status: "new", ...input });
  if (!str(input.title).trim()) throw bad(400, "an issue needs a title");
  const id = trim(input.id, 60) || newId("iss");
  fields.status = fields.status || "new";
  fields.ord = fields.ord != null ? fields.ord : await nextOrd(fields.status);
  if (!fields.reported_on) fields.reported_on = new Date().toISOString().slice(0, 10);
  if (input.templateId) fields.template_id = trim(input.templateId, 60);

  const keys = Object.keys(fields);
  const cols = ["id", ...keys];
  const marks = cols.map((_, i) => "$" + (i + 1));
  const { rows } = await tx(async q => {
    const r = await q(
      `INSERT INTO issues (${cols.join(", ")}) VALUES (${marks.join(", ")})
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, ...keys.map(k => fields[k])]);
    if (!r.rows.length) throw bad(409, "an issue with that id already exists");
    await log(q, id, "created", actor || fields.reporter || "",
      "Reported" + (fields.location_text ? " at " + fields.location_text : ""),
      { severity: fields.severity });
    return r;
  });
  return getIssue(rows[0].id);
}

/* Human-readable names for the fields worth a history line. Anything not listed
   here still saves, it just does not earn its own row in the story. */
const NOTABLE = {
  title: "Title", descr: "Description", severity: "Severity", location_text: "Location",
  reporter: "Reporter", due_on: "Due date", due_reason: "Due reason",
  close_cause: "Cause", close_confidence: "Confidence in the cause", close_review: "Review",
  close_note: "Close note", source_link: "Source link"
};

async function updateIssue(id, input, actor) {
  await init();
  const before = await getIssue(id);
  if (!before) return null;
  const fields = await cleanInput(input, before);
  if (!Object.keys(fields).length) return before;

  const statusChange = !!fields.status && fields.status !== before.status;
  // Dragging a card into Done is a close like any other, so it goes through
  // closeIssues() and gets the same history row a close button would write.
  const closing = statusChange && fields.status === "done";
  if (closing) delete fields.status;
  if (statusChange && !closing && before.status === "done") {
    fields.closed_at = null; fields.closed_by = "";
  }
  if (statusChange && !closing && fields.ord == null) fields.ord = await nextOrd(fields.status);

  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await tx(async q => {
    // A status-only drag into Done leaves nothing to set here; the close below
    // is the whole change.
    if (keys.length) {
      await q(`UPDATE issues SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
        [id, ...keys.map(k => fields[k])]);
    }
    if (statusChange) {
      await log(q, id, "status", actor, `Status ${before.status} → ${fields.status}`,
        { from: before.status, to: fields.status });
    }
    const changed = keys
      .filter(k => NOTABLE[k] && String(fields[k] ?? "") !== String(rawOf(before, k) ?? ""))
      .map(k => NOTABLE[k]);
    if (changed.length) await log(q, id, "edited", actor, changed.join(", ") + " updated", { fields: changed });
  });
  if (closing) await closeIssues([id], { actor, note: input.closeNote });
  return getIssue(id);
}

/* The column names above are the database's; the issue object handed around is
   camelCase. This maps one back to the other for the change comparison. */
const RAW_TO_KEY = {
  title: "title", descr: "descr", severity: "severity", location_text: "location",
  reporter: "reporter", due_on: "dueOn", due_reason: "dueReason",
  close_cause: "closeCause", close_confidence: "closeConfidence",
  close_review: "closeReview", close_note: "closeNote", source_link: "sourceLink"
};
const rawOf = (issue, col) => issue[RAW_TO_KEY[col] || col];

async function removeIssue(id) {
  await init();
  const { rowCount } = await run("DELETE FROM issues WHERE id = $1", [str(id)]);
  return rowCount > 0;
}

/* ------------------------------ assignment ------------------------------ */

/* One named person, offered the job, who can say yes or no. The channel's habit
   of @-mentioning somebody in a "who should be made aware" field is how the
   fixer changed three times without anybody handing over the open list. */
async function assign(id, assignee, actor) {
  await init();
  const before = await getIssue(id);
  if (!before) return null;
  const name = trim(assignee, 80);
  await tx(async q => {
    await q(`UPDATE issues SET assignee = $2, assignment_state = $3, updated_at = now() WHERE id = $1`,
      [id, name, name ? "offered" : "none"]);
    await log(q, id, "assigned", actor,
      name ? `Assigned to ${name}` : `Unassigned${before.assignee ? " from " + before.assignee : ""}`,
      { assignee: name, previous: before.assignee });
  });
  return getIssue(id);
}

async function respond(id, answer, actor) {
  await init();
  const before = await getIssue(id);
  if (!before) return null;
  if (!before.assignee) throw bad(409, "nobody is assigned to this issue yet");
  const state = answer === "accept" ? "accepted" : "declined";
  if (!ASSIGNMENT_STATES.includes(state)) throw bad(400, "answer must be accept or decline");
  await tx(async q => {
    // Declining hands the issue back: the name comes off so it lands in the
    // unassigned pile instead of sitting on somebody who already said no.
    const keep = state === "accepted";
    await q(`UPDATE issues SET assignment_state = $2, assignee = $3, updated_at = now() WHERE id = $1`,
      [id, keep ? "accepted" : "declined", keep ? before.assignee : ""]);
    await log(q, id, keep ? "accepted" : "declined", actor || before.assignee,
      keep ? `${before.assignee} accepted` : `${before.assignee} declined`,
      { assignee: before.assignee });
  });
  return getIssue(id);
}

/* ------------------------------ closing ------------------------------ */

/* One tap. A note is welcome and never required, and the cause / confidence /
   review questions are asked afterwards, by the issue page, never here — the
   one surviving close-out form in the channel came back
   "Yes / blank / 7 / blank / blank / blank" and that is what a required field
   buys you.

   Closing more than a handful at once is the one thing that does need a
   sentence, because periodic amnesty is how three previous trackers died. */
async function closeIssues(ids, { actor, note, reason } = {}) {
  await init();
  const wanted = [...new Set(list(ids))];
  if (!wanted.length) throw bad(400, "no issues to close");

  const { rows } = await run(
    `SELECT id, title, status FROM issues WHERE id = ANY($1)`, [wanted]);
  const openOnes = rows.filter(r => r.status !== "done");
  const missing = wanted.filter(id => !rows.some(r => r.id === id));

  if (openOnes.length > BULK_CLOSE_LIMIT && !str(reason).trim()) {
    throw bad(422, `closing ${openOnes.length} issues at once needs a reason`);
  }
  const batch = openOnes.length > 1 ? newId("batch") : null;
  const closed = [];
  await tx(async q => {
    for (const r of openOnes) {
      await q(
        `UPDATE issues SET status = 'done', closed_at = now(), closed_by = $2,
                close_note = CASE WHEN $3 <> '' THEN $3 ELSE close_note END,
                updated_at = now()
           WHERE id = $1`,
        [r.id, trim(actor, 80), trim(note, 1000)]);
      const body = str(reason).trim()
        ? `Closed in a batch of ${openOnes.length}: ${trim(reason, 400)}`
        : "Closed" + (str(note).trim() ? ": " + trim(note, 200) : "");
      await log(q, r.id, "closed", actor, body,
        batch ? { batch, batchSize: openOnes.length, reason: trim(reason, 400) } : {});
      closed.push(r.id);
    }
  });
  return { closed, alreadyClosed: rows.filter(r => r.status === "done").map(r => r.id), missing, batch };
}

async function reopen(id, actor, why) {
  await init();
  const before = await getIssue(id);
  if (!before) return null;
  await tx(async q => {
    await q(`UPDATE issues SET status = 'triaged', closed_at = NULL, closed_by = '', updated_at = now()
               WHERE id = $1`, [id]);
    await log(q, id, "reopened", actor, "Reopened" + (str(why).trim() ? ": " + trim(why, 300) : ""), {});
  });
  return getIssue(id);
}

async function addNote(id, body, actor) {
  await init();
  if (!str(body).trim()) throw bad(400, "a note needs some words");
  const { rows } = await run("SELECT id FROM issues WHERE id = $1", [str(id)]);
  if (!rows.length) return null;
  await tx(q => log(q, str(id), "note", actor, str(body), {}));
  return getIssue(id);
}

/* ------------------------------ supporting lists ------------------------------ */

async function locations() {
  await init();
  const { rows } = await run(
    `SELECT l.id, l.name, l.kind, l.aliases,
            (SELECT count(*) FROM issues i WHERE i.location_id = l.id AND i.status <> 'done')::int AS open
       FROM locations l WHERE l.active ORDER BY l.sort, l.name`);
  return rows.map(r => ({ id: r.id, name: r.name, kind: r.kind, aliases: r.aliases || [], open: r.open }));
}

async function people() {
  await init();
  const { rows } = await run(
    `SELECT p.id, p.name, p.role,
            (SELECT count(*) FROM issues i
              WHERE lower(i.assignee) = lower(p.name) AND i.status <> 'done')::int AS open
       FROM people p WHERE p.active ORDER BY p.name`);
  return rows.map(r => ({ id: r.id, name: r.name, role: r.role, open: r.open }));
}

/* Anyone who has reported or been assigned gets remembered, so the second time
   a volunteer files something their name is already in the list. */
async function rememberPerson(name, role) {
  const clean = trim(name, 80);
  if (!clean) return;
  await run(
    `INSERT INTO people (id, name, role) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO NOTHING`,
    ["ppl-" + clean.toLowerCase().replace(/[^a-z0-9]+/g, "-"), clean, role || "volunteer"]);
}

module.exports = {
  listIssues, getIssue, createIssue, updateIssue, removeIssue,
  assign, respond, closeIssues, reopen, addNote, history,
  locations, people, rememberPerson, where, filtersFromQuery, log, nextOrd, newId, bad, toIssue, COLS
};
