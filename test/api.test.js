"use strict";
/* End-to-end API test against a real Postgres.
   DATABASE_URL=postgres://... node --test test/api.test.js  (or npm test) */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createServer } = require("./server");
const db = require("../lib/db");

let base, server;

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test.before(async () => {
  assert.ok(process.env.DATABASE_URL, "set DATABASE_URL to a throwaway Postgres database");
  server = createServer().listen(0);
  await new Promise(r => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { await db.close(); server.closeAllConnections(); server.close(); });

test("the board is open to anyone and seeds itself", async () => {
  const { status, body } = await call("GET", "/api/cards");
  assert.equal(status, 200);
  assert.equal(body.cards.length, 11);
  assert.ok(Date.parse(body.now) > 0);
  const ramp = body.cards.find(c => c.id === "tr-ramp");
  assert.equal(ramp.title, "Transition ramp fell in");
  assert.equal(ramp.prio, "High");
  assert.equal(ramp.col, "new");
});

test("a card can be created, moved and deleted", async () => {
  const made = await call("POST", "/api/cards",
    { id: "c-test-1", title: "Dock cleat loose", col: "new", prio: "Urgent", loc: "Dock", ord: 500 });
  assert.equal(made.status, 201);
  assert.equal(made.body.card.title, "Dock cleat loose");

  const moved = await call("PATCH", "/api/cards?id=c-test-1", { col: "progress", ord: 1000 });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.card.col, "progress");
  assert.equal(moved.body.card.title, "Dock cleat loose", "a patch leaves untouched fields alone");

  const after = (await call("GET", "/api/cards")).body.cards.find(c => c.id === "c-test-1");
  assert.equal(after.col, "progress");
  assert.equal(after.prio, "Urgent");

  assert.equal((await call("DELETE", "/api/cards?id=c-test-1")).status, 200);
  assert.equal((await call("DELETE", "/api/cards?id=c-test-1")).status, 404);
  assert.ok(!(await call("GET", "/api/cards")).body.cards.some(c => c.id === "c-test-1"));
});

test("junk input is rejected or squared away, never stored raw", async () => {
  const { body } = await call("POST", "/api/cards",
    { id: "c-junk", title: "x".repeat(400), col: "nonsense", prio: "Critical", ord: "abc" });
  assert.equal(body.card.col, "new");
  assert.equal(body.card.prio, "Medium");
  assert.equal(body.card.ord, 1000);
  assert.equal(body.card.title.length, 140);
  await call("DELETE", "/api/cards?id=c-junk");

  assert.equal((await call("PATCH", "/api/cards?id=missing", { col: "done" })).status, 404);
  assert.equal((await call("PATCH", "/api/cards", { col: "done" })).status, 400);
});

test("bad input gets a bad-request answer, not a crash", async () => {
  const res = await fetch(base + "/api/cards", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json"
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "body is not valid JSON");

  assert.equal((await call("PUT", "/api/cards?id=missing")).status, 404, "an empty body patches nothing");
  const bogus = await fetch(base + "/api/cards", { method: "OPTIONS" });
  assert.equal(bogus.status, 405, "an unsupported method is refused, not a 500");
});

test("clearing the board does not bring the seed cards back", async () => {
  const before = (await call("GET", "/api/cards")).body.cards;
  for (const c of before) assert.equal((await call("DELETE", "/api/cards?id=" + c.id)).status, 200);
  await db.close();                                   // as if the next request hit a cold function
  assert.deepEqual((await call("GET", "/api/cards")).body.cards, []);
});

test("POSTGRES_URL works when DATABASE_URL is absent", async () => {
  const saved = process.env.DATABASE_URL;
  await db.close();                                   // drop the pool so the env is read again
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = saved;                   // what Neon's Vercel integration also sets
  try {
    const { status, body } = await call("GET", "/api/cards");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.cards));
  } finally {
    process.env.DATABASE_URL = saved;
    delete process.env.POSTGRES_URL;
    await db.close();
  }
});
