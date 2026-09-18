# Wild Mile Install &amp; Maintenance

A maintenance management system for Urban Rivers' Wild Mile: report a problem
from a phone in a few seconds, put a name on it, keep the photos on the record,
and close it in one tap.

It is a static page plus a handful of Vercel serverless functions over Postgres.
No framework, no build step.

## What it does

**Report from the boardwalk.** One sheet: a camera button, one sentence, a row
of location chips, send. Severity defaults to *Important*. Name, detail and a
needed-by date are behind *More detail…* and nobody has to open it. The browser
downscales photos to 1600px before uploading, so a 4 MB camera file goes up as
about 300 KB. Filing something the current filters would hide clears the
filters and says so, rather than letting the new issue vanish.

**The crew's own words.** Severity is `Urgent!` / `Important` / `Keep eyes on`,
spelled the way the Slack form has spelled it since 2021. Locations are seeded
from the places people actually name, with the aliases they type: "2017
gardens", "Nat Geo", "5D triangle", "second gathering nook". Anything typed that
matches nothing is kept as free text.

**One named assignee**, offered the job, who can accept or decline. Declining
hands the issue back to the unassigned pile instead of leaving it sitting on
somebody who already said no. Both are history rows.

**One-tap close**, with an optional after-photo. The old close-out form's good
questions — cause, how confident, who should review — are asked *after* the
close and stay optional. The one surviving submission of that form in the
channel came back `Yes / blank / 7 / blank / blank / blank`, and that is what a
required field buys you.

**Recurring inspections.** Templates with a cadence — every N days inside a
season, or on fixed dates every year — that generate dated issues when somebody
presses Generate. Nothing appears because a page was loaded, and generating
twice makes nothing the second time.

**Anti-rot.** An ageing strip across the top counts open issues nobody has
touched in a fortnight and sorts them to the top of the list. Closing more than
three at once demands a written reason, which is recorded on every one of their
histories. Fourteen Workast tasks went in seconds in 2023 and six Slack List
items in ninety seconds in 2026; this is the brake.

**Everything else:** per-issue history, board view with drag and drop, list view
that suits a hundred-plus issues, search and filters, CSV export of exactly what
the filters are showing.

### Not in here yet

- **Importing the Slack List records** (`F0839EZG03H`). Undecided, so not built.
- **Any auth.** The board is open to anyone with the link, exactly as it was.
  Treat the URL as the only thing keeping it private.

## How it fits together

    public/index.html     the page
    public/app.css        the styles
    public/app.js         the whole client
    index.html            the old standalone offline board, untouched

    api/issues.js         GET list / GET ?id= / POST / PATCH ?id= / DELETE ?id=
    api/actions.js        POST assign | accept | decline | close | reopen | note
    api/photos.js         GET ?id= bytes / GET ?issue= / POST ?issue= / DELETE ?id=
    api/recurring.js      templates, and ?do=generate
    api/meta.js           locations, people, templates, vocabulary
    api/export.js         CSV, same filters as the list

    lib/db.js             pool, schema, the carry-over from the old cards table
    lib/issues.js         issues, history, assignment, closing, filters
    lib/photos.js         photos on the record
    lib/storage.js        where a photo's bytes go: Vercel Blob or Postgres
    lib/recurring.js      cadences and the instances they make
    lib/seed.js           locations, people, inspections, the starting issues
    lib/vocab.js          the severities, statuses and thresholds
    lib/http.js           request/response helpers

    test/server.js        local stand-in for Vercel (npm run dev)
    test/api.test.js      every endpoint, against a real Postgres (npm test)
    test/migration.test.js  the cards-table carry-over, in a scratch database
    test/e2e.js           Chromium, desktop and phone (npm run e2e)

### The schema, and what happens to the old one

`lib/db.js` creates everything on first use, and every statement is
`CREATE ... IF NOT EXISTS`, so deploying against a database that already has
data changes nothing.

| Table | What it holds |
|---|---|
| `issues` | severity, status, location, reporter, assignee and its accepted/declined state, due date **with its reason**, the close-out fields |
| `locations` | the seeded places, their aliases, and what kind of thing they are |
| `people` | who reports and who fixes; anyone who files or is assigned is remembered |
| `attachments` | many photos per issue, bytes in Postgres or a Blob URL |
| `activity` | one row for everything that has ever happened to an issue |
| `inspection_templates` | recurring work; its instances are issues carrying `template_id` |

The first time `issues` is created next to an existing `cards` table, every card
is carried across: same id, priority folded onto the three severities
(`Urgent → Urgent!`, `High`/`Medium → Important`, `Low → Keep eyes on`), its
free-text place resolved onto a location record where one matches, and a history
row saying where it came from. **Nothing drops the cards table.** If the cards
table is there but empty — somebody cleared the board on purpose — the new board
starts empty too rather than sprouting seeds.

### Photos

`lib/storage.js` picks a driver at runtime:

- **Vercel Blob**, if `BLOB_READ_WRITE_TOKEN` is set. Photos go to the Blob
  store and `/api/photos?id=` redirects to them.
- **Postgres** otherwise. Bytes live in a `bytea` column, capped at 3 MB, served
  with a long immutable cache header.

There is no Blob store today and the Postgres path is the one that has been
tested. If one is created later nothing needs migrating: old photos keep serving
out of Postgres and new ones land in Blob.

## Running it

    npm install
    DATABASE_URL=postgres://localhost/wildmile npm run dev

then open <http://127.0.0.1:3000>.

    DATABASE_URL=postgres://localhost/wildmile_test npm test    # API tests
    DATABASE_URL=postgres://localhost/wildmile_test npm run e2e # Chromium

Both suites write, so point them at a database you do not mind losing — the API
tests drop and recreate their tables on every run, and the migration test
creates a scratch database of its own.

## Deploying (Vercel)

1. Push this repo to GitHub.
2. [vercel.com/new](https://vercel.com/new), import the repository. Framework
   preset **Other**; leave the build command empty. `vercel.json` already points
   the output at `public/`.
3. **Storage → Create Database**, pick **Neon** (Serverless Postgres) and attach
   it to the project. Neon's integration sets both `DATABASE_URL` and
   `POSTGRES_URL`; `lib/db.js` reads whichever is present, so there is nothing
   to copy by hand.
4. **Deploy.**

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. `POSTGRES_URL` is used if it is missing; attaching a Neon or Vercel Postgres database sets both. |
| `BLOB_READ_WRITE_TOKEN` | no | If a Vercel Blob store is attached, photos go there instead of into Postgres. |

`package.json` pins `"engines": { "node": "22.x" }`. Vercel retires Node 20
builds on 30 September 2026; leave the pin in place rather than removing it.

### Generating inspections on a schedule

Generation is deliberately explicit. To have it happen without anybody pressing
the button, point a cron at it:

    curl -X POST "https://<your-app>/api/recurring?do=generate" \
      -H 'content-type: application/json' -d '{"days":60,"actor":"nightly"}'

Running it more often than it has work to do is harmless.

## The offline board (GitHub Pages)

`index.html` at the repo root is unchanged: one self-contained file, no build,
no server, no database, cards in `localStorage`. It is the thing the shared
board exists to replace, kept because the Pages deploy points at it.
