"use strict";
const auth = require("../lib/auth");
const { send, handler } = require("../lib/http");

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  res.setHeader("Set-Cookie", auth.clearCookie());
  send(res, 200, { ok: true });
});
