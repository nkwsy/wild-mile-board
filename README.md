# Wild Mile Issue Board

A kanban board for tracking Wild Mile issue submissions at Urban Rivers.

Cards move across **New → Triaged → Scheduled → In Progress → Done**, with a
separate **Blocked / Needs Info** track. You can drag cards between columns,
add and edit them in a side panel, and filter by priority or location. It works
on desktop and on a phone.

There are two copies of the board in this repo:

| | File | Card storage | Who sees your changes |
|---|---|---|---|
| **Shared board** | `public/index.html` | Postgres, behind `/api` | everyone with the link |
| **Offline board** | `index.html` | the browser's `localStorage` | only you |

## The shared board

`public/index.html` plus the functions in `api/` make one board that the whole
crew edits. Open it and every card you add, edit, move or delete is written to
Postgres and shows up for everyone else within a few seconds. The page polls the
server every 5 seconds; it holds off while you are dragging a card or have the
editor open, so nothing moves under your hands.

There is no password: anyone who has the URL can read the board and change it.
Treat the link as the only thing keeping it private, and don't put anything on a
card you wouldn't want a stranger to read.

Two people editing the same card at the same time is last-write-wins — the
later save is the one that sticks. That is a real board for a small crew, not a
collaborative text editor, and that trade is deliberate.

If the page cannot reach the API at all — you opened the file from disk, or you
are on the GitHub Pages copy — it falls back to `localStorage` and says so in a
banner across the top: *Local copy — not shared*.

### What is where

    index.html            the standalone offline board, unchanged
    public/index.html     the shared board (served by Vercel)
    api/cards.js          GET / POST / PATCH ?id= / DELETE ?id=
    lib/db.js             Postgres: pool, table creation, the card queries
    lib/http.js           small request/response helpers
    lib/seed.js           the cards an empty board starts with
    test/server.js        local stand-in for Vercel (npm run dev)
    test/api.test.js      API tests against a real Postgres (npm test)

`lib/db.js` creates the `cards` table on first use and, if it is empty, fills it
with the seed cards from `lib/seed.js`.

## Deploying the shared board (Vercel)

1. Push this repo to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
   Framework preset **Other**; leave the build command empty. `vercel.json`
   already points the output at `public/`.
3. In the project, **Storage → Create Database**, pick **Neon** (Serverless
   Postgres) from the marketplace, and attach it to the project. Neon's Vercel
   integration sets the connection string itself — it adds both `DATABASE_URL`
   and `POSTGRES_URL`, and `lib/db.js` reads whichever is present, so there is
   nothing to copy by hand. Vercel's own Postgres works the same way.
4. **Settings → Environment Variables** — there is one, and attaching the
   database in step 3 already set it:

   | Variable | Required | What it is |
   |---|---|---|
   | `DATABASE_URL` | yes | Postgres connection string. `POSTGRES_URL` is used if `DATABASE_URL` is missing; attaching a Neon or Vercel Postgres database sets both for you, so you normally add neither. |

5. **Deploy**, then open the project URL — the board comes straight up.

`package.json` pins `"engines": { "node": "22.x" }`, so the functions build on
Node 22. Vercel retires Node 20 builds on 30 September 2026; leave the pin in
place (or raise it) rather than removing it.

### Running it locally

    npm install
    DATABASE_URL=postgres://localhost/wildmile npm run dev

then open <http://127.0.0.1:3000>. `npm test` runs the API tests; point
`DATABASE_URL` at a throwaway database, because they write to it.

## The offline board (GitHub Pages)

`index.html` at the repo root is unchanged: one self-contained file, no build,
no server, no database. Open it in a browser and it runs. Its cards live in that
browser's `localStorage`, so two people looking at it see two different boards —
which is exactly why the shared board exists.

1. Repo **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   branch `main`, folder `/ (root)`.
3. The board is live at `https://<org>.github.io/<repo>/` in a minute or two,
   and redeploys on every push to `main`.
