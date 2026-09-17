"use strict";
const auth = require("../lib/auth");
const { send, readJson, handler } = require("../lib/http");

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (!auth.password()) return send(res, 503, { error: "BOARD_PASSWORD is not set on the server" });

  const body = await readJson(req).catch(() => ({}));
  if (!auth.checkPassword(body.password)) return send(res, 401, { error: "wrong password" });

  res.setHeader("Set-Cookie", auth.setCookie(auth.makeToken()));
  send(res, 200, { ok: true });
});
