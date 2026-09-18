"use strict";
/* Recurring inspections: a template with a cadence, and the dated issues it
   produces. Weeding is "about four times a season, roughly a month apart";
   reed canary seed heads are "mid June and early July"; the hardware check-up
   is "every other week" and has never once been evidenced as run. Those are two
   different shapes, so there are two cadences:

     every_days  an interval inside a season window  (weeding, hardware check)
     on_dates    fixed month-days, every year        (seed heads, winterizing)

   Generation is explicit — somebody presses the button, or a cron calls the
   endpoint. Nothing appears on the board because a page was loaded, and running
   it twice generates nothing the second time. */

const { run, tx, init } = require("./db");
const { log } = require("./issues");
const { SEVERITIES, DEFAULT_SEVERITY } = require("./vocab");
const { str, trim, bad, newId, isDay } = require("./util");
const CADENCES = ["every_days", "on_dates"];
const MD = /^\d{2}-\d{2}$/;
const DAY = 86400000;

const toTemplate = r => ({
  id: r.id, title: r.title, descr: r.descr, severity: r.severity,
  location: r.location_text, assignee: r.assignee, cadence: r.cadence,
  intervalDays: r.interval_days, monthDays: r.month_days,
  seasonStart: r.season_start, seasonEnd: r.season_end, active: r.active,
  openInstances: r.open_instances == null ? undefined : Number(r.open_instances),
  nextDue: r.next_due || null
});

const ymd = d => d.toISOString().slice(0, 10);
const parseDay = s => new Date(str(s) + "T00:00:00Z");

async function listTemplates() {
  await init();
  const { rows } = await run(
    `SELECT t.*,
       (SELECT count(*) FROM issues i WHERE i.template_id = t.id AND i.status <> 'done')::int AS open_instances,
       (SELECT min(i.due_on) FROM issues i WHERE i.template_id = t.id AND i.status <> 'done') AS next_due
     FROM inspection_templates t ORDER BY t.active DESC, t.title`);
  return rows.map(toTemplate);
}

async function getTemplate(id) {
  await init();
  const { rows } = await run("SELECT * FROM inspection_templates WHERE id = $1", [str(id)]);
  return rows.length ? toTemplate(rows[0]) : null;
}

function cleanTemplate(input) {
  const cadence = CADENCES.includes(input.cadence) ? input.cadence : "every_days";
  const interval = Number(input.intervalDays);
  const monthDays = str(input.monthDays).split(",").map(s => s.trim()).filter(s => MD.test(s));
  if (cadence === "every_days" && !(Number.isFinite(interval) && interval >= 1)) {
    throw bad(400, "an every_days template needs intervalDays of at least 1");
  }
  if (cadence === "on_dates" && !monthDays.length) {
    throw bad(400, "an on_dates template needs monthDays like \"06-15,07-05\"");
  }
  return {
    title: trim(input.title, 160),
    descr: trim(input.descr, 2000),
    severity: SEVERITIES.includes(input.severity) ? input.severity : DEFAULT_SEVERITY,
    location_text: trim(input.location, 160),
    assignee: trim(input.assignee, 80),
    cadence,
    interval_days: cadence === "every_days" ? Math.min(Math.round(interval), 365) : null,
    month_days: monthDays.join(","),
    season_start: MD.test(str(input.seasonStart).trim()) ? str(input.seasonStart).trim() : "",
    season_end: MD.test(str(input.seasonEnd).trim()) ? str(input.seasonEnd).trim() : "",
    active: input.active === undefined ? true : !!input.active
  };
}

async function createTemplate(input) {
  await init();
  const t = cleanTemplate(input);
  if (!t.title) throw bad(400, "a template needs a title");
  const id = trim(input.id, 60) || newId("tpl");
  const keys = Object.keys(t);
  await run(
    `INSERT INTO inspection_templates (id, ${keys.join(", ")})
     VALUES ($1, ${keys.map((_, i) => "$" + (i + 2)).join(", ")})`,
    [id, ...keys.map(k => t[k])]);
  return getTemplate(id);
}

async function updateTemplate(id, input) {
  await init();
  const before = await getTemplate(id);
  if (!before) return null;
  const t = cleanTemplate({ ...before, ...input });
  if (!t.title) throw bad(400, "a template needs a title");
  const keys = Object.keys(t);
  await run(
    `UPDATE inspection_templates SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
            updated_at = now() WHERE id = $1`,
    [id, ...keys.map(k => t[k])]);
  return getTemplate(id);
}

/* Deleting a template leaves the issues it made: they are real work somebody
   may already be doing. The ON DELETE SET NULL on template_id sees to that. */
async function removeTemplate(id) {
  await init();
  const { rowCount } = await run("DELETE FROM inspection_templates WHERE id = $1", [str(id)]);
  return rowCount > 0;
}

/* Every date this template wants an instance on, between two days inclusive. */
function duesFor(t, from, to) {
  const start = parseDay(from), end = parseDay(to);
  if (!(start <= end)) return [];
  const out = [];
  const years = [];
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) years.push(y);

  if (t.cadence === "on_dates") {
    for (const y of years) {
      for (const md of str(t.monthDays).split(",").filter(Boolean)) {
        const d = parseDay(`${y}-${md}`);
        if (!isNaN(d) && d >= start && d <= end) out.push(ymd(d));
      }
    }
    return [...new Set(out)].sort();
  }

  const step = Math.max(1, Number(t.intervalDays) || 30);
  for (const y of years) {
    // No season window means all year round.
    const from0 = parseDay(`${y}-${t.seasonStart || "01-01"}`);
    let to0 = parseDay(`${y}-${t.seasonEnd || "12-31"}`);
    if (isNaN(from0) || isNaN(to0)) continue;
    // A window that ends before it starts runs over new year — winterizing
    // checks from November to February, say — so it closes in the next year
    // rather than producing nothing at all.
    if (to0 < from0) to0 = parseDay(`${y + 1}-${t.seasonEnd}`);
    if (isNaN(to0)) continue;
    for (let d = from0.getTime(); d <= to0.getTime(); d += step * DAY) {
      const day = new Date(d);
      if (day >= start && day <= end) out.push(ymd(day));
    }
  }
  return [...new Set(out)].sort();
}

/* Make the instances that are missing between today and the horizon. Returns
   what it made and what was already there, so the caller can say so out loud
   instead of leaving people guessing whether the button did anything. */
async function generate({ templateId, from, to, days, actor } = {}) {
  await init();
  const start = isDay(from) ? str(from) : ymd(new Date());
  const horizon = Math.min(Math.max(Number(days) || 60, 1), 400);
  const end = isDay(to) ? str(to) : ymd(new Date(parseDay(start).getTime() + horizon * DAY));

  const templates = (await listTemplates())
    .filter(t => t.active && (!templateId || t.id === templateId));

  const created = [];
  let skipped = 0;
  for (const t of templates) {
    const wanted = duesFor(t, start, end);
    if (!wanted.length) continue;
    const { rows } = await run(
      `SELECT to_char(due_on, 'YYYY-MM-DD') AS d FROM issues WHERE template_id = $1 AND due_on = ANY($2::date[])`,
      [t.id, wanted]);
    const have = new Set(rows.map(r => r.d));
    for (const due of wanted) {
      if (have.has(due)) { skipped++; continue; }
      const id = newId("insp");
      try {
        await tx(async q => {
          await q(
            `INSERT INTO issues (id, title, descr, severity, status, location_text, location_id,
                                 assignee, assignment_state, reporter, reported_on, due_on, due_reason,
                                 template_id, ord)
             VALUES ($1,$2,$3,$4,'scheduled',$5,
                     (SELECT l.id FROM locations l WHERE lower(l.name) = lower($5) LIMIT 1),
                     $6,$7,'Recurring inspection',$8,$8,$9,$10,
                     (SELECT coalesce(max(ord),0)+1000 FROM issues WHERE status = 'scheduled'))`,
            [id, t.title, t.descr, t.severity, t.location, t.assignee,
             t.assignee ? "offered" : "none", due, "Recurring inspection: " + t.title, t.id]);
          await log(q, id, "generated", actor, `Generated from "${t.title}", due ${due}`,
            { template: t.id, due });
        });
        created.push({ id, templateId: t.id, dueOn: due, title: t.title });
      } catch (err) {
        if (err.code === "23505") { skipped++; continue; }   // somebody else generated it first
        throw err;
      }
    }
  }
  return { created, skipped, from: start, to: end, templates: templates.length };
}

module.exports = {
  listTemplates, getTemplate, createTemplate, updateTemplate, removeTemplate,
  generate, duesFor
};
