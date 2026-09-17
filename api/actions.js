"use strict";
/* POST /api/actions — the things that happen to an issue, as opposed to edits
   to its fields. Each one writes a history row, which is the point.

   { action: "assign",  id, assignee, actor }
   { action: "accept"  | "decline", id, actor }
   { action: "close",   ids: [...], actor, note, reason }
   { action: "reopen",  id, actor, why }
   { action: "note",    id, body, actor }                                     */

const issues = require("../lib/issues");
const { send, readJson, handler } = require("../lib/http");

const ACTIONS = {
  async assign(b) {
    await issues.rememberPerson(b.assignee);
    return { issue: await issues.assign(b.id, b.assignee, b.actor) };
  },
  async accept(b) { return { issue: await issues.respond(b.id, "accept", b.actor) }; },
  async decline(b) { return { issue: await issues.respond(b.id, "decline", b.actor) }; },
  async reopen(b) { return { issue: await issues.reopen(b.id, b.actor, b.why) }; },
  async note(b) { return { issue: await issues.addNote(b.id, b.body, b.actor) }; },
  async close(b) {
    const ids = b.ids && b.ids.length ? b.ids : [b.id];
    const result = await issues.closeIssues(ids, { actor: b.actor, note: b.note, reason: b.reason });
    // One issue closed on its own page wants the whole issue back so the panel
    // can redraw; a batch only wants to know what happened.
    if (ids.length === 1 && result.closed.length === 1) {
      return { ...result, issue: await issues.getIssue(result.closed[0]) };
    }
    return result;
  }
};

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  const body = await readJson(req);
  const action = String(body.action || "");
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
    return send(res, 400, { error: "unknown action: " + (action || "(none)") });
  }
  if (action !== "close" && !body.id) return send(res, 400, { error: "missing id" });

  const out = await ACTIONS[action](body);
  if (Object.prototype.hasOwnProperty.call(out, "issue") && out.issue === null) {
    return send(res, 404, { error: "no such issue" });
  }
  send(res, 200, out);
});
