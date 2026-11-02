import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { DATA_DIR, db } from "./db.js";
import { HttpError } from "./http.js";
import { parsePrivileges, parseScope, type SessionUser } from "./privileges.js";

export const SESSION_COOKIE = "registry_session";
const SESSION_MS = Number(process.env.REGISTRY_SESSION_HOURS || 12) * 3600_000;
const SECURE = process.env.REGISTRY_SECURE_COOKIES === "1";
export const MIN_PASSWORD = 10;

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, k] = stored.split("$");
  if (alg !== "scrypt" || !s || !k) return false;
  const expected = Buffer.from(k, "base64");
  const key = crypto.scryptSync(pw, Buffer.from(s, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, key);
}

export function checkPasswordRules(pw: string): void {
  if (pw.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) throw new HttpError(400, "Password is too long");
}

/** A readable random password for temporary credentials. */
export function generatePassword(): string {
  const words = crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
  return `${words.slice(0, 4)}-${words.slice(4, 8)}-${words.slice(8, 12)}`;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(res: Response, userId: number): void {
  const token = crypto.randomBytes(32).toString("base64url");
  const t = Date.now();
  db.prepare("INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(sha(token), userId, t, t + SESSION_MS);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t);
  res.setHeader("Set-Cookie", cookie(token, SESSION_MS / 1000));
}

export function destroySession(req: Request, res: Response): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha(token));
  res.setHeader("Set-Cookie", cookie("", 0));
}

function cookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${SECURE ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

interface UserRow {
  id: number; username: string; display_name: string; email: string; role_id: number; role_name: string;
  privileges: string; study_scope: string; must_change_password: number;
}

export function loadSessionUser(userId: number): SessionUser | null {
  const r = db.prepare(`SELECT u.id, u.username, u.display_name, u.email, u.role_id, r.name AS role_name, r.privileges,
      u.study_scope, u.must_change_password
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.active = 1`).get(userId) as UserRow | undefined;
  if (!r) return null;
  return {
    id: r.id, username: r.username, displayName: r.display_name || r.username, email: r.email,
    roleId: r.role_id, roleName: r.role_name, privileges: parsePrivileges(r.privileges),
    studyScope: parseScope(r.study_scope), mustChangePassword: !!r.must_change_password,
  };
}

/** Attach req.user from the session cookie, if any. */
export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const s = db.prepare("SELECT user_id FROM sessions WHERE id = ? AND expires_at > ?").get(sha(token), Date.now()) as
      { user_id: number } | undefined;
    if (s) req.user = loadSessionUser(s.user_id) ?? undefined;
  }
  next();
}

/** Everything outside /api/auth needs a signed-in user whose password is not waiting to be changed. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, "Sign in first", "unauthenticated"));
  if (req.user.mustChangePassword) return next(new HttpError(403, "Change your password first", "password_change_required"));
  next();
}

/* ---- first-run setup ---- */
const TOKEN_FILE = path.join(DATA_DIR, "setup-token.txt");

export function setupNeeded(): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
}

/** While no user exists, keep a one-time setup token in data/setup-token.txt (readable only by the owner). */
export function ensureSetupToken(): string | null {
  if (!setupNeeded()) {
    if (fs.existsSync(TOKEN_FILE)) fs.rmSync(TOKEN_FILE);
    return null;
  }
  if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(18).toString("base64url") + "\n", { mode: 0o600 });
  return TOKEN_FILE;
}

export function checkSetupToken(token: string): boolean {
  if (!fs.existsSync(TOKEN_FILE)) return false;
  const want = Buffer.from(fs.readFileSync(TOKEN_FILE, "utf8").trim());
  const got = Buffer.from(token.trim());
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function clearSetupToken(): void {
  if (fs.existsSync(TOKEN_FILE)) fs.rmSync(TOKEN_FILE);
}

/* ---- login throttling (per IP and username, in memory) ---- */
const attempts = new Map<string, { n: number; until: number }>();
export function throttle(key: string): void {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= 5) {
    throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} min.`);
  }
}
export function noteFailure(key: string): void {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}
export function noteSuccess(key: string): void {
  attempts.delete(key);
}
