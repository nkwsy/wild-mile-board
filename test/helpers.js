"use strict";
/* Shared bits for the API tests: a server on a random port, a tiny fetch
   wrapper, and a way to hand the suite an empty database. */

const { Client } = require("pg");
const { createServer } = require("./server");

const TABLES = ["activity", "attachments", "issues", "inspection_templates", "locations", "people", "cards"];

/* The tests write; they get a database of their own, emptied first, so a run
   never depends on what the last run left behind. */
async function wipe(url) {
  const client = new Client({ connectionString: url || process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")} CASCADE`);
  } finally {
    await client.end();
  }
}

/* A one-pixel PNG, as a phone would hand it over after downscaling. */
const PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
  + "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function startServer() {
  const server = createServer().listen(0);
  await new Promise(r => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  const stop = () => { server.closeAllConnections(); server.close(); };
  return { base, call, stop };
}

module.exports = { wipe, startServer, PIXEL_PNG };
