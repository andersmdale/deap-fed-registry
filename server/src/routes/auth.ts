import { Router } from "express";
import { z } from "zod";
import {
  checkPasswordRules, checkSetupToken, clearSetupToken, createSession, destroySession, hashPassword,
  loadSessionUser, noteFailure, noteSuccess, setupNeeded, throttle, verifyPassword,
} from "../auth.js";
import { audit, db } from "../db.js";
import { h, HttpError, me, parse } from "../http.js";
import { PRIVILEGES } from "../privileges.js";

const username = z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9._@-]+$/, "use letters, digits, . _ @ -");

export function authRoutes(): Router {
  const r = Router();

  r.get("/setup", h((_req, res) => res.json({ needed: setupNeeded() })));

  r.post("/setup", h((req, res) => {
    if (!setupNeeded()) throw new HttpError(409, "Setup is already done. Sign in instead.");
    const b = parse(z.object({ token: z.string(), username, displayName: z.string().trim().max(120).default(""),
      email: z.string().trim().max(200).default(""), password: z.string() }), req.body);
    throttle("setup:" + req.ip);
    if (!checkSetupToken(b.token)) {
      noteFailure("setup:" + req.ip);
      throw new HttpError(403, "That setup token doesn't match data/setup-token.txt on the server");
    }
    checkPasswordRules(b.password);
    const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'Admin'").get() as { id: number } | undefined;
    if (!adminRole) throw new HttpError(500, "Admin role is missing");
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO users(username, display_name, email, role_id, study_scope, password_hash, created_at, updated_at)
      VALUES (?,?,?,?,'"*"',?,?,?)`).run(b.username, b.displayName, b.email, adminRole.id, hashPassword(b.password), t, t).lastInsertRowid);
    audit({ userId: id, action: "create", entity: "user", entityId: id, summary: `created the first admin account (${b.username})` });
    clearSetupToken();
    createSession(res, id);
    res.json({ user: loadSessionUser(id) });
  }));

  r.post("/login", h((req, res) => {
    const b = parse(z.object({ username: z.string().trim().max(64), password: z.string().max(200) }), req.body);
    const key = `login:${req.ip}:${b.username.toLowerCase()}`;
    throttle(key);
    const row = db.prepare("SELECT id, password_hash, active FROM users WHERE username = ?").get(b.username) as
      { id: number; password_hash: string; active: number } | undefined;
    if (!row || !row.active || !verifyPassword(b.password, row.password_hash)) {
      noteFailure(key);
      throw new HttpError(401, "Username or password is wrong, or the account is deactivated");
    }
    noteSuccess(key);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), row.id);
    createSession(res, row.id);
    res.json({ user: loadSessionUser(row.id) });
  }));

  r.post("/logout", h((req, res) => {
    destroySession(req, res);
    res.json({ ok: true });
  }));

  r.get("/me", h((req, res) => {
    const u = me(req);
    res.json({ user: u, privileges: PRIVILEGES });
  }));

  r.post("/password", h((req, res) => {
    const u = me(req);
    const b = parse(z.object({ current: z.string(), next: z.string() }), req.body);
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(u.id) as { password_hash: string };
    if (!verifyPassword(b.current, row.password_hash)) throw new HttpError(400, "Your current password is wrong");
    if (b.current === b.next) throw new HttpError(400, "Choose a password different from the current one");
    checkPasswordRules(b.next);
    db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(hashPassword(b.next), Date.now(), u.id, u.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    audit({ userId: u.id, action: "password", entity: "user", entityId: u.id, summary: "changed their password" });
    createSession(res, u.id);
    res.json({ user: loadSessionUser(u.id) });
  }));

  return r;
}
