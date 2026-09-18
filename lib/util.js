"use strict";
/* The handful of one-liners every other lib module was writing for itself. */

const str = v => (v == null ? "" : String(v));
const trim = (v, n) => str(v).trim().slice(0, n);

/* An error carrying the status the client should see. Anything without one
   becomes a 500 with the message kept off the wire. */
const bad = (status, message) => Object.assign(new Error(message), { status });

const newId = prefix =>
  prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* "Nat Geo" -> "nat-geo". Ids for people and places are made from their names,
   so the same name always lands on the same row. */
const slug = name => str(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* Postgres hands timestamps back as Date and dates back as strings; the API
   speaks ISO strings for both. */
const iso = v => (v instanceof Date ? v.toISOString() : v);

const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const dayOrNull = v => (isDay(v) ? str(v) : null);

module.exports = { str, trim, bad, newId, slug, iso, isDay, dayOrNull };
