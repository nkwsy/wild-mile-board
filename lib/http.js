"use strict";
/* Small helpers so the handlers are plain Node (req, res) functions: they run
   unchanged on Vercel and under the local test server. */

const auth = require("./auth");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/* An error carrying the status the client should see. */
const bad = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;   // Vercel parsed it
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw bad(413, "body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw bad(400, "body is not valid JSON"); }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const raw = part.slice(eq + 1).trim();
    // A hand-made cookie can hold a broken %-escape; that is a bad request, not a crash.
    try { out[part.slice(0, eq).trim()] = decodeURIComponent(raw); }
    catch { out[part.slice(0, eq).trim()] = raw; }
  }
  return out;
}

const query = req => new URL(req.url, "http://board.local").searchParams;

/* True when the request carries a valid session; otherwise it has answered 401. */
function requireAuth(req, res) {
  if (auth.validToken(cookies(req)[auth.COOKIE])) return true;
  send(res, 401, { error: "unauthorized" });
  return false;
}

/* Wraps a handler so a thrown error becomes a 500 instead of a hung request. */
const handler = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.status) return res.headersSent || send(res, err.status, { error: err.message });
    console.error(err);                               // an internal message is not the client's business
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
};

module.exports = { send, readJson, cookies, query, requireAuth, handler };
