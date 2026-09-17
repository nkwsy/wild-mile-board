"use strict";
/* Local stand-in for Vercel: serves public/ and routes /api/* to the same
   handler modules Vercel deploys. Run with
   DATABASE_URL=... npm run dev */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROUTES = {
  "/api/cards": require("../api/cards")
};
const PUBLIC = path.join(__dirname, "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".ico": "image/x-icon", ".json": "application/json" };

function createServer() {
  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = ROUTES[pathname.replace(/\/$/, "")];
    if (route) return route(req, res);

    const file = path.join(PUBLIC, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end("forbidden"); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end("not found"); }
      res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
      res.end(buf);
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => console.log("board on http://127.0.0.1:" + port));
}
