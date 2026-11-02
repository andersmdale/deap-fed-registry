import { Router } from "express";
import { z } from "zod";
import { checkPasswordRules, generatePassword, hashPassword } from "../auth.js";
import { audit, db, diffSummary, tx } from "../db.js";
import { h, HttpError, idParam, parse, requirePriv } from "../http.js";
import { PRIVILEGE_IDS, parsePrivileges, parseScope, type Privilege } from "../privileges.js";

interface UserRow {
  id: number; username: string; display_name: string; email: string; role_id: number; study_scope: string;
  active: number; must_change_password: number; last_login_at: number | null; created_at: number; created_by: number | null;
  updated_at: number; updated_by: number | null;
}
interface RoleRow { id: number; name: string; description: string; privileges: string; builtin: number; updated_at: number; updated_by: number | null }

const userOut = (r: UserRow) => ({
  id: r.id, username: r.username, displayName: r.display_name, email: r.email, roleId: r.role_id,
  studyScope: parseScope(r.study_scope), active: !!r.active, mustChangePassword: !!r.must_change_password,
  lastLoginAt: r.last_login_at, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
});
export const roleOut = (r: RoleRow, users = 0) => ({
  id: r.id, name: r.name, description: r.description, privileges: parsePrivileges(r.privileges), builtin: !!r.builtin,
  updatedAt: r.updated_at, updatedBy: r.updated_by, users,
});

const scopeSchema = z.union([z.literal("*"), z.array(z.number().int().positive()).max(500)]);
const privSchema = z.array(z.enum(PRIVILEGE_IDS as [Privilege, ...Privilege[]])).max(PRIVILEGE_IDS.length);

/** Refuse any change that would leave nobody able to manage users. */
function ensureAdminRemains(): void {
  const rows = db.prepare("SELECT r.privileges FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1").all() as { privileges: string }[];
  if (!rows.some((r) => parsePrivileges(r.privileges).includes("users.manage"))) {
    throw new HttpError(400, "At least one active user must keep the Manage users and roles privilege");
  }
}

function roleName(id: number): string {
  return (db.prepare("SELECT name FROM roles WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? `role ${id}`;
}
function scopeText(s: "*" | number[]): string {
  if (s === "*") return "all studies";
  if (!s.length) return "no studies";
  const names = s.map((id) => (db.prepare("SELECT code FROM studies WHERE id = ?").get(id) as { code: string } | undefined)?.code ?? `#${id}`);
  return names.join(", ");
}

export function adminRoutes(): Router {
  const r = Router();

  /* ---------- users ---------- */
  r.get("/users", h((req, res) => {
    requirePriv(req, "users.manage");
    res.json((db.prepare("SELECT * FROM users ORDER BY active DESC, display_name, username").all() as UserRow[]).map(userOut));
  }));

  r.post("/users", h((req, res) => {
    const u = requirePriv(req, "users.manage");
    const b = parse(z.object({
      username: z.string().trim().min(2).max(64).regex(/^[A-Za-z0-9._@-]+$/, "use letters, digits, . _ @ -"),
      displayName: z.string().trim().max(120).default(""), email: z.string().trim().max(200).default(""),
      roleId: z.number().int(), studyScope: scopeSchema.default("*"), password: z.string().optional(),
    }), req.body);
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(b.username)) throw new HttpError(409, "That username is taken");
    if (!db.prepare("SELECT 1 FROM roles WHERE id = ?").get(b.roleId)) throw new HttpError(400, "Unknown role");
    const password = b.password || generatePassword();
    checkPasswordRules(password);
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO users(username, display_name, email, role_id, study_scope, password_hash, must_change_password,
        created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,1,?,?,?,?)`)
      .run(b.username, b.displayName, b.email, b.roleId, JSON.stringify(b.studyScope), hashPassword(password), t, u.id, t, u.id).lastInsertRowid);
    audit({ userId: u.id, action: "create", entity: "user", entityId: id,
      summary: `added user ${b.username} as ${roleName(b.roleId)} (${scopeText(b.studyScope)})`,
      after: { username: b.username, displayName: b.displayName, email: b.email, role: roleName(b.roleId), studyScope: b.studyScope } });
    res.json({ user: userOut(db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow), temporaryPassword: password });
  }));

  r.put("/users/:id", h((req, res) => {
    const u = requirePriv(req, "users.manage");
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!cur) throw new HttpError(404, "No such user");
    const b = parse(z.object({
      displayName: z.string().trim().max(120), email: z.string().trim().max(200), roleId: z.number().int(),
      studyScope: scopeSchema, active: z.boolean(),
    }), req.body);
    if (!db.prepare("SELECT 1 FROM roles WHERE id = ?").get(b.roleId)) throw new HttpError(400, "Unknown role");
    if (id === u.id && !b.active) throw new HttpError(400, "You can't deactivate your own account");
    const before = { displayName: cur.display_name, email: cur.email, role: roleName(cur.role_id), studies: scopeText(parseScope(cur.study_scope)), active: !!cur.active };
    const after = { displayName: b.displayName, email: b.email, role: roleName(b.roleId), studies: scopeText(b.studyScope), active: b.active };
    tx(() => {
      db.prepare(`UPDATE users SET display_name=?, email=?, role_id=?, study_scope=?, active=?, updated_at=?, updated_by=? WHERE id=?`)
        .run(b.displayName, b.email, b.roleId, JSON.stringify(b.studyScope), b.active ? 1 : 0, Date.now(), u.id, id);
      ensureAdminRemains();
      if (!b.active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      const summary = diffSummary(before, after, ["displayName", "email", "role", "studies", "active"]);
      if (summary) audit({ userId: u.id, action: "update", entity: "user", entityId: id, summary: `${cur.username}: ${summary}`, before, after });
    })();
    res.json(userOut(db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow));
  }));

  r.post("/users/:id/password", h((req, res) => {
    const u = requirePriv(req, "users.manage");
    const id = idParam(req);
    const cur = db.prepare("SELECT username FROM users WHERE id = ?").get(id) as { username: string } | undefined;
    if (!cur) throw new HttpError(404, "No such user");
    const b = parse(z.object({ password: z.string().optional() }), req.body);
    const password = b.password || generatePassword();
    checkPasswordRules(password);
    db.prepare("UPDATE users SET password_hash=?, must_change_password=1, updated_at=?, updated_by=? WHERE id=?")
      .run(hashPassword(password), Date.now(), u.id, id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    audit({ userId: u.id, action: "password", entity: "user", entityId: id, summary: `set a temporary password for ${cur.username}` });
    res.json({ temporaryPassword: password });
  }));

  /* ---------- roles ---------- */
  r.post("/roles", h((req, res) => {
    const u = requirePriv(req, "users.manage");
    const b = parse(z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(500).default(""), privileges: privSchema }), req.body);
    if (db.prepare("SELECT 1 FROM roles WHERE name = ?").get(b.name)) throw new HttpError(409, "A role with that name exists");
    const t = Date.now();
    const id = Number(db.prepare("INSERT INTO roles(name, description, privileges, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?)")
      .run(b.name, b.description, JSON.stringify(b.privileges), t, t, u.id).lastInsertRowid);
    audit({ userId: u.id, action: "create", entity: "role", entityId: id, summary: `created role ${b.name}: ${b.privileges.join(", ") || "no privileges"}`, after: b });
    res.json(roleOut(db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow));
  }));

  r.put("/roles/:id", h((req, res) => {
    const u = requirePriv(req, "users.manage");
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow | undefined;
    if (!cur) throw new HttpError(404, "No such role");
    const b = parse(z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(500), privileges: privSchema }), req.body);
    const clash = db.prepare("SELECT id FROM roles WHERE name = ? AND id != ?").get(b.name, id);
    if (clash) throw new HttpError(409, "A role with that name exists");
    const before = { name: cur.name, description: cur.description, privileges: parsePrivileges(cur.privileges).join(", ") };
    const after = { name: b.name, description: b.description, privileges: b.privileges.join(", ") };
    tx(() => {
      db.prepare("UPDATE roles SET name=?, description=?, privileges=?, updated_at=?, updated_by=? WHERE id=?")
        .run(b.name, b.description, JSON.stringify(b.privileges), Date.now(), u.id, id);
      ensureAdminRemains();
      const summary = diffSummary(before, after, ["name", "description", "privileges"]);
      if (summary) audit({ userId: u.id, action: "update", entity: "role", entityId: id, summary: `role ${cur.name}: ${summary}`, before, after });
    })();
    res.json(roleOut(db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow));
  }));

  r.delete("/roles/:id", h((req, res) => {
    const u = requirePriv(req, "users.manage");
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow | undefined;
    if (!cur) throw new HttpError(404, "No such role");
    if (cur.builtin) throw new HttpError(400, "Built-in roles can be edited but not deleted");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ?").get(id) as { n: number }).n;
    if (n) throw new HttpError(400, `${n} user(s) still have this role. Move them to another role first.`);
    db.prepare("DELETE FROM roles WHERE id = ?").run(id);
    audit({ userId: u.id, action: "delete", entity: "role", entityId: id, summary: `deleted role ${cur.name}` });
    res.json({ ok: true });
  }));

  return r;
}
