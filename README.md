# Wild Mile Issue Board

A kanban board for tracking Wild Mile issue submissions at Urban Rivers.

Cards move across **New → Triaged → Scheduled → In Progress → Done**, with a
separate **Blocked / Needs Info** track. You can drag cards between columns,
add and edit them in a side panel, and filter by priority or location. It works
on desktop and on a phone.

There are two copies of the board in this repo:

| | File | Card storage | Who sees your changes |
|---|---|---|---|
| **Shared board** | `public/index.html` | Postgres, behind `/api` | everyone with the password |
| **Offline board** | `index.html` | the browser's `localStorage` | only you |

## The shared board

`public/index.html` plus the functions in `api/` make one board that the whole
crew edits. Open it, type the board password once, and every card you add, edit,
move or delete is written to Postgres and shows up for everyone else within a
few seconds. The page polls the server every 5 seconds; it holds off while you
are dragging a card or have the editor open, so nothing moves under your hands.

Two people editing the same card at the same time is last-write-wins — the
later save is the one that sticks. That is a real board for a small crew, not a
collaborative text editor, and that trade is deliberate.

If the page cannot reach the API at all — you opened the file from disk, or you
are on the GitHub Pages copy — it falls back to `localStorage` and says so in a
banner across the top: *Local copy — not shared*.

### What is where

    index.html            the standalone offline board, unchanged
    public/index.html     the shared board (served by Vercel)
    api/login.js          POST {password} -> sets the session cookie
    api/logout.js         POST -> clears it
    api/cards.js          GET / POST / PATCH ?id= / DELETE ?id=
    lib/db.js             Postgres: pool, table creation, the card queries
    lib/auth.js           password check and the signed session cookie
    lib/http.js           small request/response helpers
    lib/seed.js           the cards an empty board starts with
    test/server.js        local stand-in for Vercel (npm run dev)
    test/api.test.js      API tests against a real Postgres (npm test)

Every endpoint except `/api/login` returns 401 without a valid session cookie.
The cookie is httpOnly, Secure and SameSite=Lax, and holds nothing but an expiry
signed with HMAC-SHA256 — there is no session table to keep.

`lib/db.js` creates the `cards` table on first use and, if it is empty, fills it
with the seed cards from `lib/seed.js`.

## Deploying the shared board (Vercel)

1. Push this repo to GitHub.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
   Framework preset **Other**; leave the build command empty. `vercel.json`
   already points the output at `public/`.
3. In the project, **Storage → Create Database → Postgres**, and attach it to
   the project. That sets `DATABASE_URL` / `POSTGRES_URL` for you.
4. **Settings → Environment Variables**, and add:

   | Variable | Required | What it is |
   |---|---|---|
   | `DATABASE_URL` | yes | Postgres connection string. `POSTGRES_URL` also works; a Vercel Postgres sets one of these itself. |
   | `BOARD_PASSWORD` | yes | the one password the crew types to open the board. |
   | `BOARD_SECRET` | no | a long random string used to sign session cookies. Without it, a key is derived from `BOARD_PASSWORD`, which means changing the password signs everyone out. |

5. **Deploy**, then open the project URL and enter the password.

Changing `BOARD_PASSWORD` later locks out anyone who has not typed the new one.

### Running it locally

    npm install
    DATABASE_URL=postgres://localhost/wildmile BOARD_PASSWORD=whatever npm run dev

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
