"use strict";
/* Drives the real page in Chromium against a real Postgres.

   DATABASE_URL=postgres://... npm run e2e

   Two viewports: a desktop one for the board, and a phone for the report flow,
   because the phone flow is the one that decides whether any of this gets used.
   It counts its own interactions on the way through and fails if reporting an
   issue with a photo takes more than a dozen. Screenshots land in
   .playwright-out/. */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { chromium } = require("playwright");

const { createServer } = require("./server");
const db = require("../lib/db");
const { wipe } = require("./helpers");

const OUT = path.join(__dirname, "..", ".playwright-out");
const SHOT = path.join(OUT, "report-photo.png");

let failures = 0;
const check = (ok, what) => {
  console.log((ok ? "  ok   " : "  FAIL ") + what);
  if (!ok) failures++;
};

/* A real PNG, so the page's downscale-to-JPEG path runs for real rather than
   being handed something a canvas would refuse. */
function makePng(file, size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                                   // filter: none
    for (let x = 0; x < size; x++) {
      raw[p++] = 40 + ((x * 200) / size) | 0;       // a gradient, so it is visibly a photo
      raw[p++] = 90 + ((y * 120) / size) | 0;
      raw[p++] = 70;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;                         // 8-bit, truecolour
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]));
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("set DATABASE_URL to a throwaway Postgres database");
  fs.mkdirSync(OUT, { recursive: true });
  makePng(SHOT, 240);
  await wipe();

  const server = createServer().listen(0);
  await new Promise(r => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;

  const browser = await chromium.launch();
  try {
    await desktopBoard(browser, base);
    await phoneReport(browser, base);
  } finally {
    await browser.close();
    await db.close();
    server.closeAllConnections();
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

/* ---------------- the desktop board, the list, the inspections ---------------- */

async function desktopBoard(browser, base) {
  console.log("\ndesktop 1440x900");
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("dialog", d => d.accept());
  page.on("pageerror", e => check(false, "no page errors — got " + e.message));

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");

  check(await page.locator("#modetext").textContent() === "Shared board", "the page reached the server");
  check(await page.locator(".card").count() === 11, "the eleven carried-over issues are on the board");
  check((await page.locator(".schip.sev-urgent").first().textContent()).trim() === "Urgent!",
    "severity reads in their own words, exclamation mark and all");

  // Recurring inspections: generate, and watch them land as dated issues.
  await page.click('[data-view="recurring"]');
  await page.waitForSelector(".tpl");
  check(await page.locator(".tpl").count() === 5, "five seeded inspection templates");
  await page.click("#gen-run");
  await page.waitForFunction(() => /scheduled through|Nothing new/.test(document.querySelector("#gen-note").textContent));
  const genNote = await page.locator("#gen-note").textContent();
  check(/\d+ inspections? scheduled through/.test(genNote), "generating says what it made: " + genNote.trim());
  await page.screenshot({ path: path.join(OUT, "desktop-inspections.png") });

  await page.click('[data-view="board"]');
  await page.waitForSelector('[data-col="scheduled"] .card');
  const scheduled = await page.locator('[data-col="scheduled"] .card').count();
  check(scheduled > 1, `the generated inspections are on the board (${scheduled} in Scheduled)`);

  // Ageing: every seeded issue was touched a moment ago, so age one by hand.
  await db.run("UPDATE issues SET touched_at = now() - interval '40 days' WHERE id = 'natgeo'");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#stale:not([hidden])");
  check(/1 issue/.test(await page.locator("#stale-text").textContent()),
    "an untouched issue surfaces in the ageing strip");

  await page.screenshot({ path: path.join(OUT, "desktop-board.png"), fullPage: false });

  // The list, and the brake on bulk closing.
  await page.click('[data-view="list"]');
  await page.waitForSelector("#listbody tr");
  const first = await page.locator("#listbody tr").first().getAttribute("class");
  check(String(first).includes("stale-row"), "the stale issue sorts to the top of the list");

  for (let n = 0; n < 4; n++) await page.locator("#listbody input[data-pick]").nth(n).check();
  await page.waitForSelector("#bulkbar");
  check(/needs a reason/.test(await page.locator("#bulkbar").textContent()),
    "selecting four says a reason will be needed");
  await page.screenshot({ path: path.join(OUT, "desktop-list.png") });

  await page.click("#bulk-open");
  await page.waitForSelector("#bulk[open]");
  await page.click("#bulk-go");
  check(await page.locator("#bulk[open]").count() === 1, "closing four without a reason does not go through");
  await page.fill("#bulk-reason", "Fixed on the October workday and never marked");
  await page.fill("#bulk-actor", "Christopher Riccardo");
  await page.click("#bulk-go");
  await page.waitForSelector("#bulk[open]", { state: "detached" }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector("#bulk").open);
  const closedRows = await db.run("SELECT count(*)::int AS n FROM issues WHERE status = 'done'");
  check(closedRows.rows[0].n === 4, "four closed, with the reason attached");
  const reasons = await db.run(
    "SELECT body FROM activity WHERE kind = 'closed' AND body LIKE '%October workday%'");
  check(reasons.rows.length === 4, "the reason is on every one of their histories");

  await page.close();
}

/* ---------------- the flow that has to be fast ---------------- */

async function phoneReport(browser, base) {
  console.log("\nphone 390x844");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  page.on("dialog", d => d.accept());
  page.on("pageerror", e => check(false, "no page errors — got " + e.message));

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");

  let taps = 0;
  const tap = async (fn) => { taps++; await fn(); };

  await tap(() => page.click("#fab"));
  await page.waitForSelector("#report[open]");
  check(await page.locator("#shot-btn").isVisible(), "the camera button is the first thing in the sheet");

  await tap(() => page.setInputFiles("#shot-input", SHOT));
  await page.waitForSelector("#shots img");

  await tap(() => page.fill("#say", "Board near the second gathering nook is cracked and bouncy"));
  await tap(() => page.click('#where-picks [data-where]:first-child'));
  await tap(() => page.click('#sev-picks [data-sev-pick="Urgent!"]'));

  await page.screenshot({ path: path.join(OUT, "phone-report.png") });

  await tap(() => page.click("#report-send"));
  await page.waitForFunction(() => !document.querySelector("#report").open);
  await page.waitForSelector('.card:has-text("second gathering nook")');

  check(taps <= 12, `reporting with a photo took ${taps} interactions`);

  const { rows } = await db.run(
    `SELECT i.id, i.title, i.severity, i.location_text, i.location_id,
            (SELECT count(*)::int FROM attachments a WHERE a.issue_id = i.id) AS photos,
            (SELECT max(bytes) FROM attachments a WHERE a.issue_id = i.id) AS biggest
       FROM issues i WHERE i.title LIKE 'Board near%'`);
  const made = rows[0];
  check(!!made, "the report is in Postgres, not in this browser");
  check(made.severity === "Urgent!", "the severity the reporter tapped stuck");
  check(made.photos === 1, "the photo is on the record");
  check(made.biggest > 0 && made.biggest < 400 * 1024,
    `the phone downscaled the photo before sending (${Math.round(made.biggest / 1024)} KB)`);
  check(!!made.location_id, `the tapped location resolved to a record (${made.location_text})`);

  await page.screenshot({ path: path.join(OUT, "phone-board.png") });

  // Assign it, accept it, close it, and read the story back.
  await page.click(`.card[data-id="${made.id}"] .card-title`);
  await page.waitForSelector("#drawer[open]");
  await page.selectOption("#e-assignee", "Stephen Meyer");
  await page.click("#do-assign");
  await page.waitForSelector('#dbody:has-text("offered")');
  await page.click("#do-accept");
  await page.waitForSelector('#dbody:has-text("accepted")');
  await page.screenshot({ path: path.join(OUT, "phone-issue.png") });

  await page.click("#do-close");
  await page.waitForSelector("#dtitle:has-text('Closed issue')");
  check(await page.locator('#dbody:has-text("Close-out — all optional")').count() === 1,
    "the close-out questions appear only after the close, and are marked optional");

  // The after photo goes on the closed record.
  await page.setInputFiles("#add-photo-input", SHOT);
  await page.waitForFunction(() => document.querySelectorAll("#dbody .gallery img").length === 2);
  check(await page.locator("#dbody .gallery .after img").count() === 1, "the after photo is marked as one");

  const kinds = await page.$$eval("#dbody .hist .k", els => els.map(e => e.textContent.trim()));
  check(String(kinds) === "created,photo,assigned,accepted,closed,photo",
    "the history reads back the whole story: " + kinds.join(" → "));

  const shown = await page.$$eval("#dbody .hist li", els => els.map(e => e.textContent));
  check(shown.some(t => /Stephen Meyer accepted/.test(t)), "accepting is a history row you can read");

  await page.screenshot({ path: path.join(OUT, "phone-closed.png") });
  await context.close();
}

main().catch(err => { console.error(err); process.exit(1); });
