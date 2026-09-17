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

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;   // Vercel parsed it
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
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
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "server error" });
  }
};

module.exports = { send, readJson, cookies, query, requireAuth, handler };
