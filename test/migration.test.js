"use strict";
/* The one migration that has to be right: a database that already holds the old
   board's `cards` table must come up as issues, with nothing lost and nothing
   dropped. This runs in a database of its own, created for the purpose — the
   whole point is watching an empty schema meet an existing cards table.

   If the test role cannot create a database, the test says so and skips rather
   than failing on somebody else's Postgres permissions. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const db = require("../lib/db");
const { startServer } = require("./helpers");

const MAIN = process.env.DATABASE_URL || "";
const NAME = "wildmile_migration_test";

function urlFor(name) {
  const u = new URL(MAIN);
  u.pathname = "/" + name;
  return u.toString();
}

async function freshDatabase() {
  const admin = new Client({ connectionString: MAIN });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
    await admin.query(`CREATE DATABASE ${NAME}`);
  } finally {
    await admin.end();
  }
  return urlFor(NAME);
}

const OLD_CARDS = [
  ["c1", "FWM anchor unattached", "Came off in the storm.", "Phil Nicodemus", "Nat Geo island",
   "Urgent", "2025-10-28", "", "new", 1000],
  ["c2", "Curb repair", "Top of curb off / screws stripped", "Nick Wesley", "Curbing",
   "High", "2023-05-09", "https://example.test/x", "triaged", 1000],
  ["c3", "Goose shit on walkway", "", "Maya Kelly", "Boardwalk", "Medium", "2021-11-02", "", "progress", 2000],
  ["c4", "Tidy the container", "", "", "made-up place nobody named", "Low", "", "", "done", 1000]
];

test("an existing cards table is carried across, not dropped", { concurrency: false }, async t => {
  if (!MAIN) return t.skip("set DATABASE_URL to a throwaway Postgres database");

  let url;
  try {
    url = await freshDatabase();
  } catch (err) {
    return t.skip("cannot create a scratch database here: " + err.message);
  }

  const savedUrl = process.env.DATABASE_URL;
  await db.close();
  process.env.DATABASE_URL = url;

  const seedClient = new Client({ connectionString: url });
  await seedClient.connect();
  await seedClient.query(`
    CREATE TABLE cards (
      id text PRIMARY KEY, title text NOT NULL DEFAULT '', descr text NOT NULL DEFAULT '',
      reporter text NOT NULL DEFAULT '', loc text NOT NULL DEFAULT '',
      prio text NOT NULL DEFAULT 'Medium', reported text NOT NULL DEFAULT '',
      link text NOT NULL DEFAULT '', col text NOT NULL DEFAULT 'new',
      ord double precision NOT NULL DEFAULT 1000,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now())`);
  for (const c of OLD_CARDS) {
    await seedClient.query(
      `INSERT INTO cards (id,title,descr,reporter,loc,prio,reported,link,col,ord)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, c);
  }
  await seedClient.end();

  const { call, stop } = await startServer();
  try {
    const { status, body } = await call("GET", "/api/issues?scope=all");
    assert.equal(status, 200);
    assert.equal(body.issues.length, 4, "every card came across, and no seed issues joined them");

    const byId = Object.fromEntries(body.issues.map(i => [i.id, i]));
    assert.equal(byId.c1.title, "FWM anchor unattached");
    assert.equal(byId.c1.severity, "Urgent!", "Urgent keeps its exclamation mark");
    assert.equal(byId.c1.status, "new");
    assert.equal(byId.c1.locationId, "loc-nat-geo", "the old free-text place found its record");
    assert.equal(byId.c1.location, "Nat Geo island", "and the old words are still there");
    assert.equal(byId.c1.reportedOn, "2025-10-28");

    assert.equal(byId.c2.severity, "Important", "High folds onto Important");
    assert.equal(byId.c2.sourceLink, "https://example.test/x");
    assert.equal(byId.c3.severity, "Important");
    assert.equal(byId.c3.status, "progress");
    assert.equal(byId.c4.severity, "Keep eyes on", "Low folds onto Keep eyes on");
    assert.equal(byId.c4.locationId, null, "a place that matches nothing stays free text");
    assert.equal(byId.c4.reportedOn, null, "an empty reported date does not become today");
    assert.ok(byId.c4.closedAt, "a card that was already done is closed");

    const detail = await call("GET", "/api/issues?id=c2");
    assert.equal(detail.body.issue.history.length, 1);
    assert.equal(detail.body.issue.history[0].kind, "created");
    assert.match(detail.body.issue.history[0].body, /Carried over from the old board/);
    assert.equal(detail.body.issue.history[0].meta.priority, "High",
      "the priority it used to have is on the record");

    // Nothing was dropped, and a second cold start does not duplicate anything.
    const check = new Client({ connectionString: url });
    await check.connect();
    const { rows } = await check.query("SELECT count(*)::int AS n FROM cards");
    assert.equal(rows[0].n, 4, "the cards table is still sitting there, untouched");
    await check.end();

    await db.close();
    assert.equal((await call("GET", "/api/issues?scope=all")).body.issues.length, 4,
      "a cold start re-runs the migration and creates no duplicates");
  } finally {
    stop();
    await db.close();
    process.env.DATABASE_URL = savedUrl;
  }
});
