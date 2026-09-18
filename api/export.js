"use strict";
/* GET /api/export — the issues as CSV, using the same filters as the list, so
   what comes down is what was on screen. One row per issue; the columns are the
   ones somebody costing a season or writing a board report would want. */

const issues = require("../lib/issues");
const { send, sendText, query, handler } = require("../lib/http");

const COLUMNS = [
  ["id", i => i.id],
  ["title", i => i.title],
  ["severity", i => i.severity],
  ["status", i => i.status],
  ["location", i => i.location],
  ["reporter", i => i.reporter],
  ["assignee", i => i.assignee],
  ["assignment", i => i.assignmentState],
  ["reported_on", i => i.reportedOn || ""],
  ["due_on", i => i.dueOn || ""],
  ["due_reason", i => i.dueReason],
  ["days_since_touched", i => Math.floor((Date.now() - Date.parse(i.touchedAt)) / 86400000)],
  ["closed_at", i => (i.closedAt ? String(i.closedAt).slice(0, 10) : "")],
  ["closed_by", i => i.closedBy],
  ["close_note", i => i.closeNote],
  ["close_cause", i => i.closeCause],
  ["close_confidence", i => (i.closeConfidence == null ? "" : i.closeConfidence)],
  ["close_review", i => i.closeReview],
  ["photos", i => i.photoCount],
  ["recurring_template", i => i.templateId || ""],
  ["description", i => i.descr],
  ["source_link", i => i.sourceLink]
];

/* Quote everything: descriptions have commas, newlines and the odd quote in
   them, and a spreadsheet opening this should not have to guess. */
const cell = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  const rows = await issues.listIssues(issues.filtersFromQuery(query(req)));
  const csv = [COLUMNS.map(c => cell(c[0])).join(",")]
    .concat(rows.map(i => COLUMNS.map(c => cell(c[1](i))).join(",")))
    .join("\r\n") + "\r\n";
  const stamp = new Date().toISOString().slice(0, 10);
  sendText(res, 200, "﻿" + csv, "text/csv; charset=utf-8", {
    "Content-Disposition": `attachment; filename="wild-mile-issues-${stamp}.csv"`,
    "Cache-Control": "no-store"
  });
});
