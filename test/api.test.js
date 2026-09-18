"use strict";
/* End-to-end API tests against a real Postgres.
   DATABASE_URL=postgres://... node --test test/   (or npm test)

   They run in order against one database, because the story they tell is the
   story the crew tells: something gets reported from a phone, somebody takes it
   on, a photo lands on it, it gets closed, and the history says so. */

const test = require("node:test");
const assert = require("node:assert/strict");

const db = require("../lib/db");
const { wipe, startServer, PIXEL_PNG } = require("./helpers");

let call, base, stop;

test.before(async () => {
  assert.ok(process.env.DATABASE_URL, "set DATABASE_URL to a throwaway Postgres database");
  await wipe();
  ({ call, base, stop } = await startServer());
});
test.after(async () => { await db.close(); stop(); });

/* ------------------------------ /api/meta ------------------------------ */

test("meta hands the page the vocabulary and the seed lists", async () => {
  const { status, body } = await call("GET", "/api/meta");
  assert.equal(status, 200);
  assert.deepEqual(body.severities, ["Urgent!", "Important", "Keep eyes on"],
    "the severity words are theirs, exclamation mark and all");
  assert.deepEqual(body.statuses, ["new", "triaged", "scheduled", "progress", "blocked", "done"]);

  const names = body.locations.map(l => l.name);
  for (const expected of ["2017 Garden", "Nat Geo", "5D", "Gathering nooks", "Van", "Boardwalk"]) {
    assert.ok(names.includes(expected), expected + " is a seeded location");
  }
  const natgeo = body.locations.find(l => l.name === "Nat Geo");
  assert.ok(natgeo.aliases.includes("natgeo"));

  assert.ok(body.people.some(p => p.name === "Stephen Meyer"));
  assert.ok(body.templates.some(t => t.title === "Hardware check-up"));
  assert.equal(body.photoStore, "pg", "with no Blob token, photos go in Postgres");
  assert.equal(body.bulkCloseLimit, 3);
  assert.ok(Date.parse(body.now) > 0);
});

test("meta refuses anything but a read", async () => {
  assert.equal((await call("POST", "/api/meta", {})).status, 405);
});

/* ------------------------------ /api/issues ------------------------------ */

test("a fresh board comes up with the issues that were already on it", async () => {
  const { status, body } = await call("GET", "/api/issues");
  assert.equal(status, 200);
  assert.equal(body.issues.length, 11);
  const ramp = body.issues.find(i => i.id === "tr-ramp");
  assert.equal(ramp.title, "Transition ramp fell in");
  assert.equal(ramp.severity, "Urgent!");
  assert.equal(ramp.status, "new");
  assert.equal(ramp.locationId, "loc-transition-ramp", "the seed text resolved onto a real location");
});

test("a report needs a title and nothing else", async () => {
  const { status, body } = await call("POST", "/api/issues", { title: "Board feels bouncy" });
  assert.equal(status, 201);
  assert.equal(body.issue.severity, "Important", "the default is the middle one");
  assert.equal(body.issue.status, "new");
  assert.equal(body.issue.photoCount, 0);
  assert.equal(body.issue.reportedOn, new Date().toISOString().slice(0, 10));
  assert.equal(body.issue.history.length, 1);
  assert.equal(body.issue.history[0].kind, "created");
  await call("DELETE", "/api/issues?id=" + body.issue.id);

  const empty = await call("POST", "/api/issues", { descr: "no title" });
  assert.equal(empty.status, 400);
});

test("a location typed the way people talk lands on the right record", async () => {
  const cases = [
    ["2017 gardens", "loc-2017-garden"],
    ["Nat Geo", "loc-nat-geo"],
    ["5D triangle", "loc-5d"],
    ["second gathering nook", "loc-gathering-nooks"],
    ["over by the gangway", "loc-gangway"]
  ];
  for (const [typed, expected] of cases) {
    const { body } = await call("POST", "/api/issues", { title: "loc test", location: typed });
    assert.equal(body.issue.locationId, expected, `"${typed}" resolves to ${expected}`);
    assert.equal(body.issue.location, typed, "and the words the reporter used are kept");
    await call("DELETE", "/api/issues?id=" + body.issue.id);
  }

  const words = "somewhere past the far end, nobody has named it";
  const free = await call("POST", "/api/issues", { title: "loc test", location: words });
  assert.equal(free.body.issue.locationId, null, "free text that matches nothing is still accepted");
  assert.equal(free.body.issue.location, words, "and it is stored exactly as typed");
  await call("DELETE", "/api/issues?id=" + free.body.issue.id);
});

test("junk is squared away rather than stored raw", async () => {
  const { body } = await call("POST", "/api/issues", {
    title: "x".repeat(400), severity: "Critical", status: "nonsense",
    closeConfidence: 99, dueOn: "not a date", ord: "abc"
  });
  const i = body.issue;
  assert.equal(i.title.length, 160);
  assert.equal(i.severity, "Important");
  assert.equal(i.status, "new");
  assert.equal(i.closeConfidence, null);
  assert.equal(i.dueOn, null);
  assert.ok(Number.isFinite(i.ord));
  await call("DELETE", "/api/issues?id=" + i.id);
});

test("editing an issue writes what changed into its history", async () => {
  const { body: made } = await call("POST", "/api/issues",
    { title: "Curb screws stripped", location: "Curbing", reporter: "Maya Kelly" });
  const id = made.issue.id;

  const edited = await call("PATCH", "/api/issues?id=" + id,
    { severity: "Urgent!", dueOn: "2026-07-23", dueReason: "City tour of Prologis", actor: "Nick Wesley" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.issue.severity, "Urgent!");
  assert.equal(edited.body.issue.dueOn, "2026-07-23");
  assert.equal(edited.body.issue.dueReason, "City tour of Prologis",
    "the deadline carries its reason instead of living in a chat reply");

  const moved = await call("PATCH", "/api/issues?id=" + id, { status: "progress", actor: "Stephen Meyer" });
  assert.equal(moved.body.issue.status, "progress");

  const kinds = moved.body.issue.history.map(h => h.kind);
  assert.deepEqual(kinds, ["created", "edited", "status"]);
  assert.match(moved.body.issue.history[1].body, /Severity/);
  assert.match(moved.body.issue.history[2].body, /new → progress/);

  assert.equal((await call("PATCH", "/api/issues?id=nope", { title: "x" })).status, 404);
  assert.equal((await call("PATCH", "/api/issues", { title: "x" })).status, 400);
  await call("DELETE", "/api/issues?id=" + id);
});

test("search and filters narrow the list the way the page asks them to", async () => {
  const ids = [];
  for (const spec of [
    { title: "Goose shit on walkway", location: "Boardwalk", severity: "Important", assignee: "Stephen Meyer" },
    { title: "Anchor bolts sheared", location: "2017 Garden", severity: "Urgent!" },
    { title: "Pinwheels for the geese", location: "Waste Management wall", severity: "Keep eyes on" }
  ]) ids.push((await call("POST", "/api/issues", spec)).body.issue.id);

  const bySearch = await call("GET", "/api/issues?q=pinwheels");
  assert.deepEqual(bySearch.body.issues.map(i => i.title), ["Pinwheels for the geese"]);
  const wider = await call("GET", "/api/issues?q=geese");
  assert.ok(wider.body.issues.length >= 2, "search reaches the seeded issues too");
  assert.ok(wider.body.issues.every(i => /geese/i.test(i.title + i.descr)));

  const bySeverity = await call("GET", "/api/issues?severity=" + encodeURIComponent("Urgent!"));
  assert.ok(bySeverity.body.issues.every(i => i.severity === "Urgent!"));
  assert.ok(bySeverity.body.issues.some(i => i.title === "Anchor bolts sheared"));

  const byLocation = await call("GET", "/api/issues?location=loc-boardwalk");
  assert.deepEqual(byLocation.body.issues.map(i => i.title), ["Goose shit on walkway"]);

  const byAssignee = await call("GET", "/api/issues?assignee=stephen%20meyer");
  assert.deepEqual(byAssignee.body.issues.map(i => i.title), ["Goose shit on walkway"]);

  const limited = await call("GET", "/api/issues?limit=2");
  assert.equal(limited.body.issues.length, 2);

  for (const id of ids) await call("DELETE", "/api/issues?id=" + id);
});

test("ageing: an untouched issue surfaces, a worked one does not", async () => {
  const { body } = await call("POST", "/api/issues", { title: "Bird fence line snapped" });
  const id = body.issue.id;

  assert.equal((await call("GET", "/api/issues?staleDays=14")).body.issues.length, 0,
    "nothing is stale on a board where everything was just touched");

  // Age it by hand: the clock is the one thing a test cannot wait out.
  await db.run("UPDATE issues SET touched_at = now() - interval '40 days' WHERE id = $1", [id]);
  const stale = await call("GET", "/api/issues?staleDays=14");
  assert.deepEqual(stale.body.issues.map(i => i.id), [id]);

  await call("POST", "/api/actions", { action: "note", id, body: "Rang the supplier", actor: "Maya Kelly" });
  assert.equal((await call("GET", "/api/issues?staleDays=14")).body.issues.length, 0,
    "a note counts as working it, so the issue stops nagging");

  await call("DELETE", "/api/issues?id=" + id);
});

/* ------------------------------ /api/actions ------------------------------ */

test("assignment: offered, accepted, declined, and all of it on the record", async () => {
  const { body: made } = await call("POST", "/api/issues", { title: "Shedd 1 attachment points" });
  const id = made.issue.id;

  const offered = await call("POST", "/api/actions",
    { action: "assign", id, assignee: "Stephen Meyer", actor: "Nick Wesley" });
  assert.equal(offered.status, 200);
  assert.equal(offered.body.issue.assignee, "Stephen Meyer");
  assert.equal(offered.body.issue.assignmentState, "offered");

  const accepted = await call("POST", "/api/actions", { action: "accept", id, actor: "Stephen Meyer" });
  assert.equal(accepted.body.issue.assignmentState, "accepted");

  const declined = await call("POST", "/api/actions", { action: "decline", id, actor: "Stephen Meyer" });
  assert.equal(declined.body.issue.assignmentState, "declined");
  assert.equal(declined.body.issue.assignee, "", "declining hands it back to the unassigned pile");

  const kinds = declined.body.issue.history.map(h => h.kind);
  assert.deepEqual(kinds, ["created", "assigned", "accepted", "declined"]);
  assert.match(declined.body.issue.history[1].body, /Assigned to Stephen Meyer/);

  const nobody = await call("POST", "/api/actions", { action: "accept", id, actor: "Nick Wesley" });
  assert.equal(nobody.status, 409, "you cannot accept a job nobody was offered");

  assert.ok((await call("GET", "/api/meta")).body.people.some(p => p.name === "Stephen Meyer"));
  await call("DELETE", "/api/issues?id=" + id);
});

test("one tap closes an issue; the deeper questions stay optional", async () => {
  const { body: made } = await call("POST", "/api/issues", { title: "Connector pole creeping out again" });
  const id = made.issue.id;

  const closed = await call("POST", "/api/actions", { action: "close", id, actor: "Christopher Riccardo" });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.closed, [id]);
  assert.equal(closed.body.issue.status, "done");
  assert.equal(closed.body.issue.closedBy, "Christopher Riccardo");
  assert.ok(closed.body.issue.closedAt);
  assert.equal(closed.body.issue.closeCause, "", "nothing was demanded at the moment of closing");

  // Asked afterwards, answered afterwards.
  const after = await call("PATCH", "/api/issues?id=" + id,
    { closeCause: "Screw backed out", closeConfidence: 6, closeReview: "Nick Wesley", actor: "Christopher Riccardo" });
  assert.equal(after.body.issue.closeCause, "Screw backed out");
  assert.equal(after.body.issue.closeConfidence, 6);

  const reopened = await call("POST", "/api/actions", { action: "reopen", id, actor: "Nick Wesley", why: "It moved again" });
  assert.equal(reopened.body.issue.status, "triaged");
  assert.equal(reopened.body.issue.closedAt, null);
  assert.match(reopened.body.issue.history.at(-1).body, /Reopened: It moved again/);

  await call("DELETE", "/api/issues?id=" + id);
});

test("dragging a card into Done closes it properly, history and all", async () => {
  const { body: made } = await call("POST", "/api/issues", { title: "LECA rocks on the walkway" });
  const id = made.issue.id;
  const done = await call("PATCH", "/api/issues?id=" + id, { status: "done", actor: "Maya Kelly" });
  assert.equal(done.body.issue.status, "done");
  assert.ok(done.body.issue.closedAt, "the close timestamp is set even coming in off the board");
  assert.deepEqual(done.body.issue.history.map(h => h.kind), ["created", "closed"],
    "one row saying it closed, not that plus a half-written status change");
  await call("DELETE", "/api/issues?id=" + id);
});

test("closing one issue that is not there is a 404", async () => {
  const gone = await call("POST", "/api/actions", { action: "close", id: "no-such-issue", actor: "x" });
  assert.equal(gone.status, 404);
});

test("no silent bulk amnesty: closing a pile needs a reason, and it is recorded", async () => {
  const ids = [];
  for (let n = 0; n < 5; n++) {
    ids.push((await call("POST", "/api/issues", { title: "Backlog item " + n })).body.issue.id);
  }

  const refused = await call("POST", "/api/actions", { action: "close", ids, actor: "Christopher Riccardo" });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /5 issues at once needs a reason/);
  assert.equal((await call("GET", "/api/issues?id=" + ids[0])).body.issue.status, "new",
    "the refusal left every one of them open");

  const few = await call("POST", "/api/actions",
    { action: "close", ids: ids.slice(0, 3), actor: "Christopher Riccardo" });
  assert.equal(few.status, 200, "a handful still goes through without ceremony");
  assert.equal(few.body.closed.length, 3);

  const rest = await call("POST", "/api/actions", {
    action: "close", ids, actor: "Christopher Riccardo",
    reason: "Season over; the remaining two were fixed on the October workday and never marked"
  });
  assert.equal(rest.status, 200);
  assert.equal(rest.body.closed.length, 2, "the three already closed are left alone");
  assert.deepEqual(rest.body.alreadyClosed.sort(), ids.slice(0, 3).sort());

  const one = await call("GET", "/api/issues?id=" + ids[4]);
  const closeRow = one.body.issue.history.find(h => h.kind === "closed");
  assert.match(closeRow.body, /Season over/);
  assert.equal(closeRow.meta.batchSize, 2);
  assert.ok(closeRow.meta.batch, "the batch is identifiable afterwards");

  for (const id of ids) await call("DELETE", "/api/issues?id=" + id);
});

test("actions answer sensibly when the issue or the verb is wrong", async () => {
  assert.equal((await call("POST", "/api/actions", { action: "sing", id: "x" })).status, 400);
  assert.equal((await call("POST", "/api/actions", { action: "assign" })).status, 400);
  assert.equal((await call("POST", "/api/actions", { action: "assign", id: "nope", assignee: "A" })).status, 404);
  assert.equal((await call("POST", "/api/actions", { action: "note", id: "nope", body: "hi" })).status, 404);
  assert.equal((await call("GET", "/api/actions")).status, 405);
  assert.equal((await call("POST", "/api/actions", { action: "close", ids: [] })).status, 400);
});

/* ------------------------------ /api/photos ------------------------------ */

test("photos hang off the issue, several of them, and serve back as bytes", async () => {
  const { body: made } = await call("POST", "/api/issues", { title: "Two large holes in the WM wall" });
  const id = made.issue.id;

  const up = await call("POST", "/api/photos?issue=" + id,
    { dataUrl: PIXEL_PNG, caption: "north end", actor: "Phil Nicodemus" });
  assert.equal(up.status, 201);
  assert.equal(up.body.photo.mime, "image/png");
  assert.equal(up.body.photo.caption, "north end");

  await call("POST", "/api/photos?issue=" + id, { dataUrl: PIXEL_PNG, actor: "Phil Nicodemus" });
  const after = await call("POST", "/api/photos?issue=" + id,
    { dataUrl: PIXEL_PNG, kind: "after", actor: "Stephen Meyer" });
  assert.equal(after.body.photo.kind, "after");

  const listed = await call("GET", "/api/photos?issue=" + id);
  assert.equal(listed.body.photos.length, 3);

  const raw = await fetch(base + up.body.photo.src);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "image/png");
  assert.match(raw.headers.get("cache-control"), /immutable/);
  assert.equal((await raw.arrayBuffer()).byteLength, 70, "the bytes come back as they went in");

  const onBoard = (await call("GET", "/api/issues")).body.issues.find(i => i.id === id);
  assert.equal(onBoard.photoCount, 3);
  assert.equal(onBoard.firstPhoto, up.body.photo.id, "the board can show the first photo without a second call");

  const detail = await call("GET", "/api/issues?id=" + id);
  assert.equal(detail.body.issue.photoCount, 3);
  assert.equal(detail.body.issue.photos.length, 3);
  assert.equal(detail.body.issue.history.filter(h => h.kind === "photo").length, 3);

  const gone = await call("DELETE", "/api/photos?id=" + up.body.photo.id);
  assert.equal(gone.status, 200);
  assert.equal((await call("GET", "/api/photos?issue=" + id)).body.photos.length, 2);

  await call("DELETE", "/api/issues?id=" + id);
  assert.equal((await call("GET", "/api/photos?id=" + after.body.photo.id)).status, 404,
    "deleting the issue takes its photos with it");
});

test("the photo endpoint turns away what it should", async () => {
  const { body: made } = await call("POST", "/api/issues", { title: "photo guard" });
  const id = made.issue.id;

  assert.equal((await call("POST", "/api/photos?issue=" + id, { dataUrl: "not a data url" })).status, 400);
  assert.equal((await call("POST", "/api/photos?issue=nope", { dataUrl: PIXEL_PNG })).status, 404);
  assert.equal((await call("POST", "/api/photos", { dataUrl: PIXEL_PNG })).status, 400);

  const pdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4").toString("base64");
  assert.equal((await call("POST", "/api/photos?issue=" + id, { dataUrl: pdf })).status, 415);

  const huge = "data:image/jpeg;base64," + Buffer.alloc(3.2 * 1024 * 1024).toString("base64");
  const rejected = await call("POST", "/api/photos?issue=" + id, { dataUrl: huge });
  assert.equal(rejected.status, 413);
  assert.match(rejected.body.error, /the limit is/);

  assert.equal((await call("GET", "/api/photos")).status, 400);
  assert.equal((await call("GET", "/api/photos?id=nope")).status, 404);
  assert.equal((await call("DELETE", "/api/photos?id=nope")).status, 404);
  assert.equal((await call("PATCH", "/api/photos?id=x")).status, 405);

  await call("DELETE", "/api/issues?id=" + id);
});

/* ------------------------------ /api/recurring ------------------------------ */

test("recurring inspections generate dated issues, once", async () => {
  const listed = await call("GET", "/api/recurring");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.templates.some(t => t.title === "Cut reed canary grass seed heads"));

  const made = await call("POST", "/api/recurring", {
    title: "Anchor inspection after storms", severity: "Important",
    location: "2017 Garden", cadence: "every_days", intervalDays: 7,
    seasonStart: "01-01", seasonEnd: "12-31"
  });
  assert.equal(made.status, 201);
  const tplId = made.body.template.id;

  // An explicit window, so the count does not depend on what today happens to be.
  const window = { templateId: tplId, from: "2027-01-01", to: "2027-01-29" };
  const gen = await call("POST", "/api/recurring?do=generate", { ...window, actor: "Nick Wesley" });
  assert.equal(gen.status, 200);
  assert.deepEqual(gen.body.created.map(c => c.dueOn),
    ["2027-01-01", "2027-01-08", "2027-01-15", "2027-01-22", "2027-01-29"],
    "four weeks at a seven-day cadence, both endpoints included");
  assert.equal(gen.body.skipped, 0);

  const again = await call("POST", "/api/recurring?do=generate", window);
  assert.equal(again.body.created.length, 0, "running it twice does not double the work");
  assert.equal(again.body.skipped, 5);

  const instances = await call("GET", "/api/issues?template=" + tplId);
  assert.equal(instances.body.issues.length, 5);
  const first = instances.body.issues[0];
  assert.equal(first.status, "scheduled");
  assert.equal(first.dueOn, "2027-01-01", "an instance is dated");
  assert.match(first.dueReason, /Recurring inspection/);
  assert.equal(first.locationId, "loc-2017-garden");

  const detail = await call("GET", "/api/issues?id=" + first.id);
  assert.equal(detail.body.issue.history[0].kind, "generated");

  const changed = await call("PATCH", "/api/recurring?id=" + tplId, { intervalDays: 14, active: false });
  assert.equal(changed.body.template.intervalDays, 14);
  assert.equal(changed.body.template.active, false);
  const quiet = await call("POST", "/api/recurring?do=generate", { days: 400 });
  assert.ok(!quiet.body.created.some(c => c.templateId === tplId), "a switched-off template makes nothing");

  const dropped = await call("DELETE", "/api/recurring?id=" + tplId);
  assert.equal(dropped.status, 200);
  const orphans = await call("GET", "/api/issues?id=" + first.id);
  assert.equal(orphans.status, 200, "the work it made is real work and survives the template");
  assert.equal(orphans.body.issue.templateId, null);

  for (const i of instances.body.issues) await call("DELETE", "/api/issues?id=" + i.id);
  for (const c of quiet.body.created) await call("DELETE", "/api/issues?id=" + c.id);
});

test("a season that runs past new year still generates", async () => {
  const made = await call("POST", "/api/recurring", {
    title: "Winter anchor watch", cadence: "every_days", intervalDays: 30,
    seasonStart: "11-01", seasonEnd: "02-28"
  });
  assert.equal(made.status, 201);
  const gen = await call("POST", "/api/recurring?do=generate",
    { templateId: made.body.template.id, from: "2026-11-01", to: "2027-02-28" });
  assert.deepEqual(gen.body.created.map(c => c.dueOn),
    ["2026-11-01", "2026-12-01", "2026-12-31", "2027-01-30"],
    "the window closes in the following year rather than producing nothing");
  for (const c of gen.body.created) await call("DELETE", "/api/issues?id=" + c.id);
  await call("DELETE", "/api/recurring?id=" + made.body.template.id);
});

test("a template that could never produce a date is refused", async () => {
  assert.equal((await call("POST", "/api/recurring", { title: "No cadence", cadence: "every_days" })).status, 400);
  assert.equal((await call("POST", "/api/recurring", { title: "No dates", cadence: "on_dates" })).status, 400);
  assert.equal((await call("POST", "/api/recurring", { cadence: "on_dates", monthDays: "06-15" })).status, 400);
  assert.equal((await call("GET", "/api/recurring?id=nope")).status, 404);
  assert.equal((await call("PATCH", "/api/recurring?id=nope", { title: "x" })).status, 404);
  assert.equal((await call("DELETE", "/api/recurring?id=nope")).status, 404);
  assert.equal((await call("PATCH", "/api/recurring", { title: "x" })).status, 400);
});

/* ------------------------------ /api/export ------------------------------ */

test("the export is a CSV of exactly what the filters asked for", async () => {
  const res = await fetch(base + "/api/export?q=transition");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="wild-mile-issues-\d{4}-\d{2}-\d{2}\.csv"/);

  const text = await res.text();
  const lines = text.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines.length, 2, "a header and the one matching issue");
  assert.match(lines[0], /^"id","title","severity","status","location"/);
  assert.match(lines[1], /"Transition ramp fell in","Urgent!"/);
  assert.match(lines[0], /"days_since_touched"/);

  const all = (await (await fetch(base + "/api/export?scope=all")).text()).trim().split("\r\n");
  assert.ok(all.length > lines.length, "scope=all reaches the closed ones too");
  assert.equal((await call("POST", "/api/export")).status, 405);
});

/* ------------------------------ the edges ------------------------------ */

test("bad input gets a bad-request answer, not a crash", async () => {
  const res = await fetch(base + "/api/issues", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{not json"
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "body is not valid JSON");

  assert.equal((await call("DELETE", "/api/issues")).status, 400);
  assert.equal((await call("DELETE", "/api/issues?id=nope")).status, 404);
  assert.equal((await fetch(base + "/api/issues", { method: "OPTIONS" })).status, 405);

  const fat = await fetch(base + "/api/issues", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x", descr: "y".repeat(100 * 1024) })
  });
  assert.equal(fat.status, 413, "the plain endpoints keep their small body limit");
});

test("POSTGRES_URL works when DATABASE_URL is absent", async () => {
  const saved = process.env.DATABASE_URL;
  await db.close();                                   // drop the pool so the env is read again
  delete process.env.DATABASE_URL;
  process.env.POSTGRES_URL = saved;                   // what Neon's Vercel integration also sets
  try {
    const { status, body } = await call("GET", "/api/issues");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.issues));
  } finally {
    process.env.DATABASE_URL = saved;
    delete process.env.POSTGRES_URL;
    await db.close();
  }
});

test("a board somebody emptied stays empty across a cold start", async () => {
  const open = (await call("GET", "/api/issues?scope=all")).body.issues;
  for (const i of open) assert.equal((await call("DELETE", "/api/issues?id=" + i.id)).status, 200);
  await db.close();                                   // as if the next request hit a cold function
  assert.deepEqual((await call("GET", "/api/issues?scope=all")).body.issues, []);
});
