"use strict";
/* Postgres access for the shared board. One pool per warm serverless instance;
   the table is created (and seeded) lazily on the first query. */

const { Pool } = require("pg");
const SEEDS = require("./seed");

const COLS = ["new", "triaged", "scheduled", "progress", "done", "blocked"];
const PRIOS = ["Urgent", "High", "Medium", "Low"];

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
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
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

/* Create the table on first use, and fill a brand new one with the seed cards.
   Seeding keys off "the table did not exist", not "the table is empty", so a
   board someone has deliberately cleared does not sprout the seeds again the
   next time a cold function starts. */
function init() {
  if (ready) return ready;
  ready = (async () => {
    const { rows: [pre] } = await run("SELECT to_regclass('cards') IS NOT NULL AS present");
    await run(`
      CREATE TABLE IF NOT EXISTS cards (
        id         text PRIMARY KEY,
        title      text NOT NULL DEFAULT '',
        descr      text NOT NULL DEFAULT '',
        reporter   text NOT NULL DEFAULT '',
        loc        text NOT NULL DEFAULT '',
        prio       text NOT NULL DEFAULT 'Medium',
        reported   text NOT NULL DEFAULT '',
        link       text NOT NULL DEFAULT '',
        col        text NOT NULL DEFAULT 'new',
        ord        double precision NOT NULL DEFAULT 1000,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    if (pre.present) return;
    const per = {};
    for (const s of SEEDS) {
      per[s.col] = (per[s.col] || 0) + 1;
      await write({ ...s, ord: per[s.col] * 1000 });   // write(), not upsert(): init is not finished yet
    }
  })().catch(err => { ready = null; throw err; });
  return ready;
}

const str = v => (v == null ? "" : String(v));

/* Takes whatever the client sent and returns a card safe to store. */
function clean(input) {
  const ord = Number(input.ord);
  return {
    id: str(input.id) || "c-" + Date.now().toString(36),
    title: str(input.title).slice(0, 140) || "Untitled issue",
    desc: str(input.desc).slice(0, 1200),
    reporter: str(input.reporter).slice(0, 80),
    loc: str(input.loc).slice(0, 80),
    prio: PRIOS.includes(input.prio) ? input.prio : "Medium",
    date: str(input.date).slice(0, 10),
    link: str(input.link).slice(0, 500),
    col: COLS.includes(input.col) ? input.col : "new",
    ord: Number.isFinite(ord) ? ord : 1000
  };
}

const rowToCard = r => ({
  id: r.id, title: r.title, desc: r.descr, reporter: r.reporter, loc: r.loc,
  prio: r.prio, date: r.reported, link: r.link, col: r.col, ord: Number(r.ord),
  updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at
});

const CARD_COLS = "id, title, descr, reporter, loc, prio, reported, link, col, ord, updated_at";

/* Insert or overwrite one whole card. Last write wins, which is what we want. */
async function write(card) {
  const c = clean(card);
  const { rows } = await run(
    `INSERT INTO cards (id, title, descr, reporter, loc, prio, reported, link, col, ord)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, descr=EXCLUDED.descr, reporter=EXCLUDED.reporter,
       loc=EXCLUDED.loc, prio=EXCLUDED.prio, reported=EXCLUDED.reported,
       link=EXCLUDED.link, col=EXCLUDED.col, ord=EXCLUDED.ord, updated_at=now()
     RETURNING ${CARD_COLS}`,
    [c.id, c.title, c.desc, c.reporter, c.loc, c.prio, c.date, c.link, c.col, c.ord]
  );
  return rowToCard(rows[0]);
}

/* Apply only the fields the caller sent, leaving the rest of the row alone. */
async function upsert(card) {
  await init();
  return write(card);
}

async function patch(id, fields) {
  await init();
  const { rows } = await run(`SELECT ${CARD_COLS} FROM cards WHERE id = $1`, [String(id)]);
  if (!rows.length) return null;
  return write({ ...rowToCard(rows[0]), ...fields, id: rows[0].id });
}

async function list() {
  await init();
  const { rows } = await run(`SELECT ${CARD_COLS} FROM cards ORDER BY col, ord`);
  return rows.map(rowToCard);
}

async function remove(id) {
  await init();
  const { rowCount } = await run("DELETE FROM cards WHERE id = $1", [String(id)]);
  return rowCount > 0;
}

/* Tests reuse one process across databases; this drops the cached pool. */
async function close() {
  const p = pool;
  pool = null; ready = null;
  if (p) await p.end();
}

module.exports = { list, upsert, patch, remove, close };
