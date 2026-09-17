"use strict";
/* Postgres access. One pool per warm serverless instance; the schema is created
   lazily on the first query and every statement is CREATE ... IF NOT EXISTS, so
   a deploy against a database that already has data changes nothing.

   The one migration that matters: this board used to be a single `cards` table.
   When `issues` is created for the first time and a `cards` table is sitting
   there, every card is carried across. The cards table is left alone — nothing
   here drops it — so the old board keeps working until somebody says otherwise. */

const { Pool, types } = require("pg");

/* A `date` column is a plain calendar day; hand it back as "YYYY-MM-DD" instead
   of a Date that has picked up the server's timezone on the way out. */
types.setTypeParser(1082, v => v);
const { SEVERITIES, STATUSES, PRIO_TO_SEVERITY, DEFAULT_SEVERITY } = require("./vocab");
const { LOCATIONS, PEOPLE, TEMPLATES, ISSUES } = require("./seed");

let pool = null;
let ready = null;

function connectionString() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
  return url;
}

function getPool() {
  if (pool) return pool;
  const url = connectionString();
  // Hosted Postgres always wants TLS; a local cluster used for tests has none.
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /^postgres(ql)?:\/\/\/|host=\/|localhost/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10000
  });
  pool.on("error", () => {});   // a dropped idle client must not kill the process
  return pool;
}

const run = (text, params) => getPool().query(text, params);

/* Runs fn inside a transaction on one client. Used where a write has to be all
   or nothing — closing an issue and writing its history row, for instance. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn((text, params) => client.query(text, params));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* the client is going back anyway */ }
    throw err;
  } finally {
    client.release();
  }
}

const present = async name => {
  const { rows: [r] } = await run("SELECT to_regclass($1) IS NOT NULL AS yes", [name]);
  return r.yes;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS locations (
     id       text PRIMARY KEY,
     name     text NOT NULL,
     kind     text NOT NULL DEFAULT 'other',
     aliases  text[] NOT NULL DEFAULT '{}',
     sort     double precision NOT NULL DEFAULT 1000,
     active   boolean NOT NULL DEFAULT true
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS locations_name_key ON locations (lower(name))`,

  `CREATE TABLE IF NOT EXISTS people (
     id         text PRIMARY KEY,
     name       text NOT NULL,
     role       text NOT NULL DEFAULT 'volunteer',
     active     boolean NOT NULL DEFAULT true,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS people_name_key ON people (lower(name))`,

  `CREATE TABLE IF NOT EXISTS inspection_templates (
     id            text PRIMARY KEY,
     title         text NOT NULL,
     descr         text NOT NULL DEFAULT '',
     severity      text NOT NULL DEFAULT 'Keep eyes on',
     location_text text NOT NULL DEFAULT '',
     assignee      text NOT NULL DEFAULT '',
     cadence       text NOT NULL DEFAULT 'every_days',
     interval_days integer,
     month_days    text NOT NULL DEFAULT '',
     season_start  text NOT NULL DEFAULT '',
     season_end    text NOT NULL DEFAULT '',
     active        boolean NOT NULL DEFAULT true,
     created_at    timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS issues (
     id               text PRIMARY KEY,
     title            text NOT NULL DEFAULT '',
     descr            text NOT NULL DEFAULT '',
     severity         text NOT NULL DEFAULT '${DEFAULT_SEVERITY}',
     status           text NOT NULL DEFAULT 'new',
     location_id      text REFERENCES locations(id) ON DELETE SET NULL,
     location_text    text NOT NULL DEFAULT '',
     reporter         text NOT NULL DEFAULT '',
     assignee         text NOT NULL DEFAULT '',
     assignment_state text NOT NULL DEFAULT 'none',
     reported_on      date,
     due_on           date,
     due_reason       text NOT NULL DEFAULT '',
     source_link      text NOT NULL DEFAULT '',
     template_id      text REFERENCES inspection_templates(id) ON DELETE SET NULL,
     ord              double precision NOT NULL DEFAULT 1000,
     created_at       timestamptz NOT NULL DEFAULT now(),
     updated_at       timestamptz NOT NULL DEFAULT now(),
     touched_at       timestamptz NOT NULL DEFAULT now(),
     closed_at        timestamptz,
     closed_by        text NOT NULL DEFAULT '',
     close_note       text NOT NULL DEFAULT '',
     close_cause      text NOT NULL DEFAULT '',
     close_confidence integer,
     close_review     text NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS issues_status_idx  ON issues (status)`,
  `CREATE INDEX IF NOT EXISTS issues_touched_idx ON issues (touched_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS issues_instance_key
     ON issues (template_id, due_on) WHERE template_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS attachments (
     id         text PRIMARY KEY,
     issue_id   text NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
     kind       text NOT NULL DEFAULT 'photo',
     mime       text NOT NULL DEFAULT 'image/jpeg',
     bytes      integer NOT NULL DEFAULT 0,
     driver     text NOT NULL DEFAULT 'pg',
     url        text NOT NULL DEFAULT '',
     data       bytea,
     caption    text NOT NULL DEFAULT '',
     created_by text NOT NULL DEFAULT '',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS attachments_issue_idx ON attachments (issue_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS activity (
     id         bigserial PRIMARY KEY,
     issue_id   text NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
     kind       text NOT NULL,
     actor      text NOT NULL DEFAULT '',
     body       text NOT NULL DEFAULT '',
     meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS activity_issue_idx ON activity (issue_id, id)`
];

async function seedLocations() {
  for (const l of LOCATIONS) {
    await run(
      `INSERT INTO locations (id, name, kind, aliases, sort) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [l.id, l.name, l.kind, l.aliases, l.sort]
    );
  }
}

async function seedPeople() {
  for (const p of PEOPLE) {
    await run(`INSERT INTO people (id, name, role) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.name, p.role]);
  }
}

async function seedTemplates() {
  for (const t of TEMPLATES) {
    await run(
      `INSERT INTO inspection_templates
         (id, title, descr, severity, location_text, cadence, interval_days, month_days, season_start, season_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [t.id, t.title, t.descr, t.severity, t.location_text, t.cadence,
       t.interval_days || null, t.month_days || "", t.season_start || "", t.season_end || ""]
    );
  }
}

/* Match a free-text place against the seeded locations, by name or alias, so a
   card that said "Nat Geo island" lands on the Nat Geo record.

   Exact first; failing that, look for a place name sitting inside the sentence,
   because people write "the board near the second gathering nook" rather than
   picking from a list. Only terms of four characters or more are looked for
   loosely, and only on a word boundary, so "WF" does not claim every report
   with the letters in it. The longest match wins: "boat dock" beats "dock".

   Returns an id or null; either way the reporter's own words are kept, because
   those words are often the only thing that says which end of the thing broke. */
async function resolveLocation(text) {
  const typed = String(text || "").trim().toLowerCase();
  if (!typed) return null;
  const { rows } = await run("SELECT id, name, aliases FROM locations WHERE active");

  for (const r of rows) {
    if ([r.name, ...(r.aliases || [])].some(t => String(t).toLowerCase() === typed)) return r.id;
  }

  const terms = [];
  for (const r of rows) {
    for (const t of [r.name, ...(r.aliases || [])]) {
      const term = String(t).toLowerCase();
      if (term.length >= 4) terms.push({ id: r.id, term });
    }
  }
  terms.sort((a, b) => b.term.length - a.term.length);
  const escape = t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const { id, term } of terms) {
    // Not \b: a term can end in punctuation, and \b would then never match.
    if (new RegExp("(?<![a-z0-9])" + escape(term) + "(?![a-z0-9])").test(typed)) return id;
  }
  return null;
}

/* Carry the old board across. Every card becomes an issue with the same id, so
   running this twice is harmless, and each one gets a history row saying where
   it came from. */
async function carryOverCards() {
  const { rows } = await run(
    `SELECT id, title, descr, reporter, loc, prio, reported, link, col, ord, created_at, updated_at
       FROM cards ORDER BY col, ord`);
  let moved = 0;
  for (const c of rows) {
    const severity = PRIO_TO_SEVERITY[c.prio] || DEFAULT_SEVERITY;
    const status = STATUSES.includes(c.col) ? c.col : "new";
    const reported = /^\d{4}-\d{2}-\d{2}$/.test(c.reported || "") ? c.reported : null;
    const { rowCount } = await run(
      `INSERT INTO issues (id, title, descr, severity, status, location_id, location_text,
                           reporter, reported_on, source_link, ord, created_at, updated_at, touched_at,
                           closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.title, c.descr, severity, status, await resolveLocation(c.loc), c.loc || "",
       c.reporter || "", reported, c.link || "", Number(c.ord) || 1000,
       c.created_at, c.updated_at, status === "done" ? c.updated_at : null]
    );
    if (!rowCount) continue;
    moved++;
    await run(
      `INSERT INTO activity (issue_id, kind, actor, body, meta, created_at)
       VALUES ($1,'created','','Carried over from the old board',$2,$3)`,
      [c.id, JSON.stringify({ from: "cards", priority: c.prio }), c.created_at]
    );
  }
  return moved;
}

async function seedIssues() {
  for (const s of ISSUES) {
    const reported = /^\d{4}-\d{2}-\d{2}$/.test(s.reported_on || "") ? s.reported_on : null;
    await run(
      `INSERT INTO issues (id, title, descr, severity, status, location_id, location_text,
                           reporter, reported_on, due_on, due_reason, source_link)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.title, s.descr || "", SEVERITIES.includes(s.severity) ? s.severity : DEFAULT_SEVERITY,
       STATUSES.includes(s.status) ? s.status : "new", await resolveLocation(s.location_text),
       s.location_text || "", s.reporter || "", reported, s.due_on || null,
       s.due_reason || "", s.source_link || ""]
    );
    await run(`INSERT INTO activity (issue_id, kind, actor, body) VALUES ($1,'created',$2,'Reported')`,
      [s.id, s.reporter || ""]);
  }
}

/* Create everything, then fill in whichever tables are brand new. Seeding keys
   off "the table did not exist", not "the table is empty", so a board someone
   has deliberately cleared does not sprout its seeds again on the next cold
   start. */
function init() {
  if (ready) return ready;
  ready = (async () => {
    const fresh = {
      locations: !(await present("locations")),
      people: !(await present("people")),
      templates: !(await present("inspection_templates")),
      issues: !(await present("issues"))
    };
    const hadCards = await present("cards");

    for (const stmt of SCHEMA) await run(stmt);

    if (fresh.locations) await seedLocations();
    if (fresh.people) await seedPeople();
    if (fresh.templates) await seedTemplates();
    if (fresh.issues) {
      // An existing cards table is the record, seeds or not: if the crew emptied
      // it, the new board starts empty too.
      if (hadCards) await carryOverCards();
      else await seedIssues();
    }
  })().catch(err => { ready = null; throw err; });
  return ready;
}

/* Tests reuse one process across databases; this drops the cached pool. */
async function close() {
  const p = pool;
  pool = null; ready = null;
  if (p) await p.end();
}

module.exports = { run, tx, init, close, resolveLocation, getPool };
