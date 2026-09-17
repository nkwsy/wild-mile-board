"use strict";
/* End-to-end API test against a real Postgres.
   DATABASE_URL=postgres://... node --test test/api.test.js  (or npm test) */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOARD_PASSWORD = process.env.BOARD_PASSWORD || "test-password";
delete process.env.BOARD_SECRET;

const { createServer } = require("./server");
const db = require("../lib/db");

let base, server, cookie = "";

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(";")[0];
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

test("cards are refused without a session", async () => {
  assert.equal((await call("GET", "/api/cards")).status, 401);
  assert.equal((await call("POST", "/api/cards", { title: "sneaky" })).status, 401);
  assert.equal((await call("DELETE", "/api/cards?id=tr-ramp")).status, 401);
});

test("the wrong password does not open the board", async () => {
  assert.equal((await call("POST", "/api/login", { password: "nope" })).status, 401);
  assert.equal(cookie, "");
});

test("the right password opens the board and seeds it", async () => {
  assert.equal((await call("POST", "/api/login", { password: "test-password" })).status, 200);
  assert.ok(cookie.startsWith("board_session="));

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

test("a tampered cookie is not a session", async () => {
  const good = cookie;
  cookie = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
  assert.equal((await call("GET", "/api/cards")).status, 401);
  cookie = good;
  assert.equal((await call("GET", "/api/cards")).status, 200);
});

test("logging out closes the session", async () => {
  assert.equal((await call("POST", "/api/logout")).status, 200);
  assert.equal(cookie, "board_session=");
  assert.equal((await call("GET", "/api/cards")).status, 401);
});
