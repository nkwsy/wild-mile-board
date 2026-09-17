"use strict";
/* GET    /api/cards          every card, plus the server clock for polling
   POST   /api/cards          create (or overwrite) one card
   PATCH  /api/cards?id=...   change some fields of one card
   DELETE /api/cards?id=...   remove one card                                  */

const db = require("../lib/db");
const { send, readJson, query, requireAuth, handler } = require("../lib/http");

module.exports = handler(async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = query(req).get("id");

  if (req.method === "GET") {
    return send(res, 200, { cards: await db.list(), now: new Date().toISOString() });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "expected a card object" });
    return send(res, 201, { card: await db.upsert(body) });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const card = await db.patch(id, await readJson(req));
    return card ? send(res, 200, { card }) : send(res, 404, { error: "no such card" });
  }

  if (req.method === "DELETE") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const gone = await db.remove(id);
    return gone ? send(res, 200, { ok: true }) : send(res, 404, { error: "no such card" });
  }

  send(res, 405, { error: "method not allowed" });
});
