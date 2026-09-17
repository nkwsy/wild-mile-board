# Wild Mile Issue Board

A kanban board for tracking Wild Mile issue submissions at Urban Rivers.

Cards move across **New → Triaged → Scheduled → In Progress → Done**, with a
separate **Blocked / Needs Info** track. You can drag cards between columns,
add and edit them in a side panel, and filter by priority or location. It works
on desktop and on a phone.

## Single static page

The whole board is one self-contained file: `index.html`. No build step, no
dependencies, no server. Open it in a browser and it runs.

## Card state is per-browser, not shared

Card positions and edits are saved in the browser's `localStorage`. That means:

- Your changes survive a reload on the same browser.
- Your changes are **not** visible to anyone else. Two people looking at the
  same URL will see two different boards.

Making this one shared board requires a small database behind the page (and
some form of access control, since a public URL otherwise lets anyone wipe it).
That work is not done yet.

## Deploying

### GitHub Pages

1. Push this repo to GitHub.
2. Repo **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   branch `main`, folder `/ (root)`.
4. Save. The board is live at `https://<org>.github.io/<repo>/` in a minute or
   two, and redeploys on every push to `main`.

### Vercel

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project → Import Git Repository** and pick this repo.
3. Framework preset: **Other**. Leave build command and output directory empty —
   it is a static page and needs no build.
4. **Deploy**. Vercel serves `index.html` at the project URL and redeploys on
   every push to `main`.
