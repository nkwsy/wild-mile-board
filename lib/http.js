"use strict";
/* Small helpers so the handlers are plain Node (req, res) functions: they run
   unchanged on Vercel and under the local test server. */

const DEFAULT_LIMIT = 64 * 1024;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, type, headers) {
  res.statusCode = status;
  res.setHeader("Content-Type", type || "text/plain; charset=utf-8");
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  res.end(body);
}

/* An error carrying the status the client should see. */
const bad = (status, message) => Object.assign(new Error(message), { status });

/* `limit` is generous on the photo endpoint only: a downscaled phone photo is a
   few hundred KB, base64 adds a third, and Vercel refuses a request body over
   4.5 MB anyway. */
async function readJson(req, limit = DEFAULT_LIMIT) {
  if (req.body && typeof req.body === "object") return req.body;   // Vercel parsed it
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw bad(413, "body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw bad(400, "body is not valid JSON"); }
}

const query = req => new URL(req.url, "http://board.local").searchParams;

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

module.exports = { send, sendText, readJson, query, handler, bad };
