"use strict";
/* GET    /api/issues             the issues, filtered; ?id= for one with photos and history
   POST   /api/issues             file a new one — title is the only field that matters
   PATCH  /api/issues?id=...      change some fields
   DELETE /api/issues?id=...      remove it for good                                    */

const issues = require("../lib/issues");
const { send, readJson, query, handler } = require("../lib/http");

module.exports = handler(async (req, res) => {
  const q = query(req);
  const id = q.get("id");

  if (req.method === "GET") {
    if (id) {
      const issue = await issues.getIssue(id);
      return issue ? send(res, 200, { issue }) : send(res, 404, { error: "no such issue" });
    }
    return send(res, 200, {
      issues: await issues.listIssues(issues.filtersFromQuery(q)),
      now: new Date().toISOString()
    });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    if (!body || typeof body !== "object") return send(res, 400, { error: "expected an issue object" });
    const issue = await issues.createIssue(body, body.actor || body.reporter);
    await issues.rememberPerson(body.reporter);
    return send(res, 201, { issue });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const body = await readJson(req);
    const issue = await issues.updateIssue(id, body, body.actor);
    return issue ? send(res, 200, { issue }) : send(res, 404, { error: "no such issue" });
  }

  if (req.method === "DELETE") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const gone = await issues.removeIssue(id);
    return gone ? send(res, 200, { ok: true }) : send(res, 404, { error: "no such issue" });
  }

  send(res, 405, { error: "method not allowed" });
});
