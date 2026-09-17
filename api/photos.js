"use strict";
/* GET    /api/photos?id=...        the image itself
   GET    /api/photos?issue=...     what is attached to one issue
   POST   /api/photos?issue=...     add one: { dataUrl, kind, caption, actor }
   DELETE /api/photos?id=...        take it off the record                     */

const photos = require("../lib/photos");
const { send, sendText, readJson, query, handler } = require("../lib/http");

/* Base64 is a third bigger than the bytes it carries; this leaves room for a
   3 MB photo and nothing much beyond it. Vercel refuses anything over 4.5 MB
   before the function is even called. */
const BODY_LIMIT = 4.4 * 1024 * 1024;

module.exports = handler(async (req, res) => {
  const q = query(req);
  const id = q.get("id");
  const issueId = q.get("issue");

  if (req.method === "GET") {
    if (issueId) return send(res, 200, { photos: await photos.listPhotos(issueId) });
    if (!id) return send(res, 400, { error: "missing ?id= or ?issue=" });
    const row = await photos.readPhoto(id);
    if (!row) return send(res, 404, { error: "no such photo" });
    if (row.driver === "blob" && row.url) {
      res.statusCode = 302;
      res.setHeader("Location", row.url);
      return res.end();
    }
    // The bytes never change once written, so let the browser keep them.
    return sendText(res, 200, row.data, row.mime, {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(row.bytes || (row.data ? row.data.length : 0))
    });
  }

  if (req.method === "POST") {
    if (!issueId) return send(res, 400, { error: "missing ?issue=" });
    const body = await readJson(req, BODY_LIMIT);
    const photo = await photos.addPhoto(issueId, body);
    return send(res, 201, { photo });
  }

  if (req.method === "DELETE") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const gone = await photos.removePhoto(id, q.get("actor") || "");
    return gone ? send(res, 200, { ok: true }) : send(res, 404, { error: "no such photo" });
  }

  send(res, 405, { error: "method not allowed" });
});
