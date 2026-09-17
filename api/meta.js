"use strict";
/* GET /api/meta — everything the page needs to draw itself before it has any
   issues: the places, the people, the words, and where photos are being kept. */

const issues = require("../lib/issues");
const recurring = require("../lib/recurring");
const storage = require("../lib/storage");
const vocab = require("../lib/vocab");
const { send, handler } = require("../lib/http");

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  const [locations, people, templates] = await Promise.all([
    issues.locations(), issues.people(), recurring.listTemplates()
  ]);
  send(res, 200, {
    locations,
    people,
    templates,
    severities: vocab.SEVERITIES,
    statuses: vocab.STATUSES,
    staleDays: vocab.STALE_DAYS,
    bulkCloseLimit: vocab.BULK_CLOSE_LIMIT,
    photoStore: storage.driverName(),
    maxPhotoBytes: storage.MAX_BYTES,
    maxPhotoEdge: storage.MAX_EDGE,
    now: new Date().toISOString()
  });
});
