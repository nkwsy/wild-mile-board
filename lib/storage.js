"use strict";
/* Where a photo's bytes actually go.

   Two drivers, picked at runtime by whether a Blob token exists. Nick has not
   created a Blob store, so the Postgres driver is the one that has to work on
   its own: photos go in a bytea column, capped, and the phone shrinks them
   before they are ever sent. If a `BLOB_READ_WRITE_TOKEN` shows up later,
   nothing needs migrating — old photos keep serving out of Postgres and new
   ones land in Blob. */

/* A phone photo is 3-5 MB straight off the camera. The browser downscales to
   the long edge below and re-encodes as JPEG, which lands around 200-400 KB;
   this is the backstop for anything that arrives without going through that. */
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 1600;

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const usingBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const driverName = () => (usingBlob() ? "blob" : "pg");

/* "data:image/jpeg;base64,/9j/4AAQ..." -> { mime, buffer } */
function decodeDataUrl(dataUrl) {
  const m = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  let buffer;
  try { buffer = Buffer.from(m[2], "base64"); } catch { return null; }
  if (!buffer.length) return null;
  return { mime, buffer };
}

/* Stores one photo and returns the columns the attachments row needs. */
async function put(id, mime, buffer) {
  if (!usingBlob()) return { driver: "pg", url: "", data: buffer };
  // Lazily required so a deployment without a Blob store never loads it.
  const { put: blobPut } = require("@vercel/blob");
  const ext = (mime.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const res = await blobPut(`issues/${id}.${ext}`, buffer, {
    access: "public",
    contentType: mime,
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
  return { driver: "blob", url: res.url, data: null };
}

/* Best effort: a photo whose row is gone is already invisible, and a Blob
   delete that fails should not take the request down with it. */
async function remove(row) {
  if (row.driver !== "blob" || !row.url) return;
  try {
    const { del } = require("@vercel/blob");
    await del(row.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (err) {
    console.error("blob delete failed for " + row.url, err.message);
  }
}

module.exports = { MAX_BYTES, MAX_EDGE, ALLOWED, usingBlob, driverName, decodeDataUrl, put, remove };
