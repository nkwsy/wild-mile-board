"use strict";
/* The words the crew already uses, in one place. The severity list is theirs
   verbatim — it is the wording on the Slack form they have reached for since
   2021 — so it is spelled with the exclamation mark and never "translated". */

const SEVERITIES = ["Urgent!", "Important", "Keep eyes on"];
const DEFAULT_SEVERITY = "Important";

const STATUSES = ["new", "triaged", "scheduled", "progress", "blocked", "done"];
const OPEN_STATUSES = STATUSES.filter(s => s !== "done");

/* The old board's four priorities, folded onto the three the crew says out
   loud. Used once, when the cards table is carried over. */
const PRIO_TO_SEVERITY = {
  Urgent: "Urgent!",
  High: "Important",
  Medium: "Important",
  Low: "Keep eyes on"
};

const ASSIGNMENT_STATES = ["none", "offered", "accepted", "declined"];

/* Activity kinds. Every row on an issue's history is one of these. */
const ACTIVITY_KINDS = [
  "created", "edited", "status", "assigned", "accepted", "declined",
  "closed", "reopened", "photo", "note", "generated"
];

/* Closing more than this many issues in one action needs a written reason.
   Fourteen Workast tasks went in seconds in 2023; this is the brake. */
const BULK_CLOSE_LIMIT = 3;

/* An open issue nobody has touched in this many days is surfaced at the top. */
const STALE_DAYS = 14;

module.exports = {
  SEVERITIES, DEFAULT_SEVERITY, STATUSES, OPEN_STATUSES, PRIO_TO_SEVERITY,
  ASSIGNMENT_STATES, ACTIVITY_KINDS, BULK_CLOSE_LIMIT, STALE_DAYS
};
