"use strict";
/* Password gate. One shared password checked against BOARD_PASSWORD; on success
   the browser gets an httpOnly cookie holding an HMAC-signed expiry. There is no
   session store — the signature is the whole proof. */

const crypto = require("crypto");

const COOKIE = "board_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

const sha256 = s => crypto.createHash("sha256").update(String(s)).digest();

function password() {
  return process.env.BOARD_PASSWORD || "";
}

/* BOARD_SECRET signs tokens. Without one, derive a stable key from the password
   so a deployment works with a single env var (rotating the password logs
   everyone out, which is the behaviour you want anyway). */
function secret() {
  return process.env.BOARD_SECRET ? Buffer.from(process.env.BOARD_SECRET) : sha256("sig:" + password());
}

function equal(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));   // hashing first keeps lengths equal
}

function sign(exp) {
  return crypto.createHmac("sha256", secret()).update(String(exp)).digest("base64url");
}

function makeToken(now = Date.now()) {
  const exp = now + TTL_MS;
  return exp + "." + sign(exp);
}

function validToken(token) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = sign(exp);
  if (sig.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  return Number(exp) > Date.now();
}

const cookie = (value, maxAgeSec) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;

const setCookie = token => cookie(token, Math.floor(TTL_MS / 1000));
const clearCookie = () => cookie("", 0);

const checkPassword = given => !!password() && typeof given === "string" && equal(given, password());

module.exports = { COOKIE, checkPassword, makeToken, validToken, setCookie, clearCookie, password };
