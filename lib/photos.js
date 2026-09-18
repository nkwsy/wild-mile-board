"use strict";
/* Photos on the record. Nine photos and a video were the entire evidence base
   for the Waste Management holes, and they lived in a chat thread nobody can
   query. Here they hang off the issue, many per issue, and adding one writes a
   history row like anything else. */

const { run, tx, init } = require("./db");
const { log } = require("./issues");
const storage = require("./storage");
const { trim, bad, newId, iso } = require("./util");

const KINDS = ["photo", "after"];

async function addPhoto(issueId, { dataUrl, mime, base64, kind, caption, actor }) {
  await init();
  const { rows } = await run("SELECT id FROM issues WHERE id = $1", [String(issueId)]);
  if (!rows.length) throw bad(404, "no such issue");

  let decoded = dataUrl ? storage.decodeDataUrl(dataUrl) : null;
  if (!decoded && base64) {
    try { decoded = { mime: String(mime || "image/jpeg"), buffer: Buffer.from(base64, "base64") }; }
    catch { decoded = null; }
  }
  if (!decoded || !decoded.buffer.length) throw bad(400, "expected a base64 image in dataUrl");
  if (!storage.ALLOWED.includes(decoded.mime)) {
    throw bad(415, `${decoded.mime} is not an image this board stores`);
  }
  if (decoded.buffer.length > storage.MAX_BYTES) {
    throw bad(413, `that photo is ${Math.round(decoded.buffer.length / 1024)} KB; the limit is ${
      Math.round(storage.MAX_BYTES / 1024)} KB`);
  }

  const id = newId("ph");
  const stored = await storage.put(id, decoded.mime, decoded.buffer);
  const photoKind = KINDS.includes(kind) ? kind : "photo";

  await tx(async q => {
    await q(
      `INSERT INTO attachments (id, issue_id, kind, mime, bytes, driver, url, data, caption, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, issueId, photoKind, decoded.mime, decoded.buffer.length, stored.driver,
       stored.url, stored.data, trim(caption, 200), trim(actor, 80)]);
    await log(q, issueId, "photo", actor,
      photoKind === "after" ? "After photo added" : "Photo added", { photo: id, kind: photoKind });
  });

  return {
    id, kind: photoKind, mime: decoded.mime, bytes: decoded.buffer.length,
    caption: trim(caption, 200), by: trim(actor, 80),
    src: "/api/photos?id=" + encodeURIComponent(id)
  };
}

/* The bytes, for serving. Blob-stored photos come back as a url to redirect to. */
async function readPhoto(id) {
  await init();
  const { rows } = await run(
    `SELECT id, mime, bytes, driver, url, data FROM attachments WHERE id = $1`, [String(id)]);
  return rows.length ? rows[0] : null;
}

async function listPhotos(issueId) {
  await init();
  const { rows } = await run(
    `SELECT id, kind, mime, bytes, caption, created_by, created_at
       FROM attachments WHERE issue_id = $1 ORDER BY created_at, id`, [String(issueId)]);
  return rows.map(p => ({
    id: p.id, kind: p.kind, mime: p.mime, bytes: p.bytes, caption: p.caption,
    by: p.created_by, at: iso(p.created_at),
    src: "/api/photos?id=" + encodeURIComponent(p.id)
  }));
}

async function removePhoto(id, actor) {
  await init();
  const { rows } = await run(
    `SELECT id, issue_id, driver, url FROM attachments WHERE id = $1`, [String(id)]);
  if (!rows.length) return false;
  const row = rows[0];
  await tx(async q => {
    await q("DELETE FROM attachments WHERE id = $1", [row.id]);
    await log(q, row.issue_id, "photo", actor, "Photo removed", { photo: row.id, removed: true });
  });
  await storage.remove(row);
  return true;
}

module.exports = { addPhoto, readPhoto, listPhotos, removePhoto };
