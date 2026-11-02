import { Router } from "express";
import { z } from "zod";
import { audit, db, diffSummary } from "../db.js";
import { h, HttpError, idParam, me, parse, requirePriv } from "../http.js";
import { PRIVILEGES } from "../privileges.js";
import { roleOut } from "./admin.js";

/* ---------- row shapes and mappers ---------- */
interface StudyRow { id: number; code: string; name: string; release: string; tre: string; access: string; default_host: string;
  description: string; sort_order: number; archived: number; updated_at: number; updated_by: number | null }
interface CategoryRow { id: number; parent_id: number | null; code: string; label: string; description: string; sort_order: number;
  archived: number; updated_at: number; updated_by: number | null }
export interface LocationRow { id: number; study_id: number; category_id: number; kind: string; host: string; path: string; format: string;
  version: string; notes: string; ready: number; ready_by: number | null; ready_at: number | null; produced_by_run: number | null;
  archived: number; created_at: number; created_by: number | null; updated_at: number; updated_by: number | null }
interface CellRow { study_id: number; category_id: number; not_applicable: number; note: string; updated_at: number; updated_by: number | null }
interface WorkflowRow { id: number; name: string; description: string; host: string; tool: string; version: string; command: string;
  other_outputs: string; sort_order: number; archived: number; updated_at: number; updated_by: number | null }
export interface RunRow { id: number; workflow_id: number; study_id: number; status: string; host: string; output_path: string; version: string;
  notes: string; inputs: string; created_at: number; created_by: number | null; updated_at: number; updated_by: number | null }

const studyOut = (r: StudyRow) => ({ id: r.id, code: r.code, name: r.name, release: r.release, tre: r.tre, access: r.access,
  defaultHost: r.default_host, description: r.description, sortOrder: r.sort_order, archived: !!r.archived, updatedAt: r.updated_at, updatedBy: r.updated_by });
const categoryOut = (r: CategoryRow) => ({ id: r.id, parentId: r.parent_id, code: r.code, label: r.label, description: r.description,
  sortOrder: r.sort_order, archived: !!r.archived, updatedAt: r.updated_at, updatedBy: r.updated_by });
export const locationOut = (r: LocationRow) => ({ id: r.id, studyId: r.study_id, categoryId: r.category_id, kind: r.kind, host: r.host,
  path: r.path, format: r.format, version: r.version, notes: r.notes, ready: !!r.ready, readyBy: r.ready_by, readyAt: r.ready_at,
  producedByRun: r.produced_by_run, archived: !!r.archived, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by });
const cellOut = (r: CellRow) => ({ studyId: r.study_id, categoryId: r.category_id, notApplicable: !!r.not_applicable, note: r.note,
  updatedAt: r.updated_at, updatedBy: r.updated_by });
export const runOut = (r: RunRow) => ({ id: r.id, workflowId: r.workflow_id, studyId: r.study_id, status: r.status, host: r.host,
  outputPath: r.output_path, version: r.version, notes: r.notes, inputs: JSON.parse(r.inputs || "{}"),
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by });

function workflowsOut(includeArchived: boolean) {
  const rows = db.prepare(`SELECT * FROM workflows ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY sort_order, name`).all() as WorkflowRow[];
  const io = db.prepare("SELECT workflow_id, category_id, direction FROM workflow_io").all() as { workflow_id: number; category_id: number; direction: string }[];
  return rows.map((w) => ({
    id: w.id, name: w.name, description: w.description, host: w.host, tool: w.tool, version: w.version, command: w.command,
    otherOutputs: w.other_outputs, sortOrder: w.sort_order, archived: !!w.archived, updatedAt: w.updated_at, updatedBy: w.updated_by,
    inputs: io.filter((x) => x.workflow_id === w.id && x.direction === "in").map((x) => x.category_id),
    outputs: io.filter((x) => x.workflow_id === w.id && x.direction === "out").map((x) => x.category_id),
  }));
}
export { workflowsOut };

export function studyLabel(id: number): string {
  const s = db.prepare("SELECT name, release FROM studies WHERE id = ?").get(id) as { name: string; release: string } | undefined;
  return s ? s.name + (s.release ? " " + s.release : "") : `study ${id}`;
}
export function categoryLabel(id: number): string {
  return (db.prepare("SELECT label FROM categories WHERE id = ?").get(id) as { label: string } | undefined)?.label ?? `category ${id}`;
}
function requireStudy(id: number): void {
  if (!db.prepare("SELECT 1 FROM studies WHERE id = ?").get(id)) throw new HttpError(400, "Unknown study");
}
function requireCategory(id: number): void {
  if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id)) throw new HttpError(400, "Unknown data category");
}

const studySchema = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, . _ -"),
  name: z.string().trim().min(1).max(120), release: z.string().trim().max(40).default(""), tre: z.string().trim().max(60).default(""),
  access: z.enum(["tre", "sumstats", "other"]).default("tre"), defaultHost: z.string().trim().max(200).default(""),
  description: z.string().trim().max(4000).default(""), sortOrder: z.number().int().default(0),
});
const categorySchema = z.object({
  parentId: z.number().int().positive().nullable().default(null),
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, . _ -"),
  label: z.string().trim().min(1).max(120), description: z.string().trim().max(2000).default(""), sortOrder: z.number().int().default(0),
});
const locationSchema = z.object({
  kind: z.enum(["directory", "file"]).default("directory"), host: z.string().trim().max(200).default(""),
  path: z.string().trim().min(1, "enter a path").max(4000), format: z.string().trim().max(200).default(""),
  version: z.string().trim().max(80).default(""), notes: z.string().trim().max(4000).default(""),
});

export function dataRoutes(): Router {
  const r = Router();

  /** Everything the client needs to draw the registry, in one read. */
  r.get("/state", h((req, res) => {
    const u = me(req);
    res.json({
      me: u,
      privileges: PRIVILEGES,
      studies: (db.prepare("SELECT * FROM studies ORDER BY sort_order, name").all() as StudyRow[]).map(studyOut),
      categories: (db.prepare("SELECT * FROM categories ORDER BY sort_order, label").all() as CategoryRow[]).map(categoryOut),
      locations: (db.prepare("SELECT * FROM locations WHERE archived = 0 ORDER BY category_id, created_at").all() as LocationRow[]).map(locationOut),
      cells: (db.prepare("SELECT * FROM cell_status").all() as CellRow[]).map(cellOut),
      workflows: workflowsOut(true),
      runs: (db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 2000").all() as RunRow[]).map(runOut),
      roles: (db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.active = 1) AS n FROM roles r ORDER BY r.builtin DESC, r.name`)
        .all() as (RoleRow2)[]).map((x) => roleOut(x, x.n)),
      people: db.prepare("SELECT id, username, CASE display_name WHEN '' THEN username ELSE display_name END AS displayName, active FROM users ORDER BY displayName").all()
        .map((p) => ({ ...(p as { id: number; username: string; displayName: string; active: number }), active: !!(p as { active: number }).active })),
    });
  }));

  /* ---------- studies ---------- */
  r.post("/studies", h((req, res) => {
    const u = requirePriv(req, "studies.manage");
    const b = parse(studySchema, req.body);
    if (db.prepare("SELECT 1 FROM studies WHERE code = ?").get(b.code)) throw new HttpError(409, "A study with that code exists");
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO studies(code, name, release, tre, access, default_host, description, sort_order, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.code, b.name, b.release, b.tre, b.access, b.defaultHost, b.description, b.sortOrder, t, u.id, t, u.id).lastInsertRowid);
    audit({ userId: u.id, action: "create", entity: "study", entityId: id, studyId: id, summary: `added study ${b.name}${b.release ? " " + b.release : ""}`, after: b });
    res.json(studyOut(db.prepare("SELECT * FROM studies WHERE id = ?").get(id) as StudyRow));
  }));

  r.put("/studies/:id", h((req, res) => {
    const u = requirePriv(req, "studies.manage");
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM studies WHERE id = ?").get(id) as StudyRow | undefined;
    if (!cur) throw new HttpError(404, "No such study");
    const b = parse(studySchema.extend({ archived: z.boolean().default(false) }), req.body);
    if (db.prepare("SELECT 1 FROM studies WHERE code = ? AND id != ?").get(b.code, id)) throw new HttpError(409, "A study with that code exists");
    const before = studyOut(cur);
    db.prepare(`UPDATE studies SET code=?, name=?, release=?, tre=?, access=?, default_host=?, description=?, sort_order=?, archived=?, updated_at=?, updated_by=? WHERE id=?`)
      .run(b.code, b.name, b.release, b.tre, b.access, b.defaultHost, b.description, b.sortOrder, b.archived ? 1 : 0, Date.now(), u.id, id);
    const after = studyOut(db.prepare("SELECT * FROM studies WHERE id = ?").get(id) as StudyRow);
    const summary = diffSummary(before, after, ["code", "name", "release", "tre", "access", "defaultHost", "description", "sortOrder", "archived"]);
    if (summary) audit({ userId: u.id, action: before.archived !== after.archived ? (after.archived ? "archive" : "restore") : "update",
      entity: "study", entityId: id, studyId: id, summary: `${studyLabel(id)}: ${summary}`, before, after });
    res.json(after);
  }));

  /* ---------- categories ---------- */
  function checkParent(parentId: number | null, selfId?: number) {
    if (parentId == null) return;
    const p = db.prepare("SELECT parent_id FROM categories WHERE id = ?").get(parentId) as { parent_id: number | null } | undefined;
    if (!p) throw new HttpError(400, "Unknown parent category");
    if (p.parent_id != null) throw new HttpError(400, "Categories have two levels: pick a top-level group as the parent");
    if (selfId != null && parentId === selfId) throw new HttpError(400, "A category can't be its own parent");
    if (selfId != null && db.prepare("SELECT 1 FROM categories WHERE parent_id = ?").get(selfId)) {
      throw new HttpError(400, "This category has sub-categories, so it must stay a top-level group");
    }
  }

  r.post("/categories", h((req, res) => {
    const u = requirePriv(req, "categories.manage");
    const b = parse(categorySchema, req.body);
    checkParent(b.parentId);
    if (db.prepare("SELECT 1 FROM categories WHERE code = ?").get(b.code)) throw new HttpError(409, "A category with that code exists");
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO categories(parent_id, code, label, description, sort_order, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(b.parentId, b.code, b.label, b.description, b.sortOrder, t, u.id, t, u.id).lastInsertRowid);
    audit({ userId: u.id, action: "create", entity: "category", entityId: id, categoryId: id,
      summary: `added data category ${b.label}${b.parentId ? " under " + categoryLabel(b.parentId) : ""}`, after: b });
    res.json(categoryOut(db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow));
  }));

  r.put("/categories/:id", h((req, res) => {
    const u = requirePriv(req, "categories.manage");
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
    if (!cur) throw new HttpError(404, "No such category");
    const b = parse(categorySchema.extend({ archived: z.boolean().default(false) }), req.body);
    checkParent(b.parentId, id);
    if (db.prepare("SELECT 1 FROM categories WHERE code = ? AND id != ?").get(b.code, id)) throw new HttpError(409, "A category with that code exists");
    const before = categoryOut(cur);
    db.prepare("UPDATE categories SET parent_id=?, code=?, label=?, description=?, sort_order=?, archived=?, updated_at=?, updated_by=? WHERE id=?")
      .run(b.parentId, b.code, b.label, b.description, b.sortOrder, b.archived ? 1 : 0, Date.now(), u.id, id);
    const after = categoryOut(db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow);
    const summary = diffSummary(before, after, ["parentId", "code", "label", "description", "sortOrder", "archived"]);
    if (summary) audit({ userId: u.id, action: before.archived !== after.archived ? (after.archived ? "archive" : "restore") : "update",
      entity: "category", entityId: id, categoryId: id, summary: `${cur.label}: ${summary}`, before, after });
    res.json(after);
  }));

  /* ---------- data locations ---------- */
  r.post("/locations", h((req, res) => {
    const b = parse(locationSchema.extend({ studyId: z.number().int(), categoryId: z.number().int() }), req.body);
    const u = requirePriv(req, "locations.edit", b.studyId);
    requireStudy(b.studyId); requireCategory(b.categoryId);
    const t = Date.now();
    const id = Number(db.prepare(`INSERT INTO locations(study_id, category_id, kind, host, path, format, version, notes, created_at, created_by, updated_at, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.studyId, b.categoryId, b.kind, b.host, b.path, b.format, b.version, b.notes, t, u.id, t, u.id).lastInsertRowid);
    const after = locationOut(db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow);
    audit({ userId: u.id, action: "create", entity: "location", entityId: id, studyId: b.studyId, categoryId: b.categoryId,
      summary: `added ${b.kind} ${b.host ? b.host + ": " : ""}${b.path}`, after });
    res.json(after);
  }));

  r.put("/locations/:id", h((req, res) => {
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow | undefined;
    if (!cur || cur.archived) throw new HttpError(404, "No such data location");
    const u = requirePriv(req, "locations.edit", cur.study_id);
    const b = parse(locationSchema, req.body);
    const moved = b.path !== cur.path || b.host !== cur.host || b.kind !== cur.kind;
    const clearReady = moved && !!cur.ready;
    db.prepare(`UPDATE locations SET kind=?, host=?, path=?, format=?, version=?, notes=?, ready=?, ready_by=?, ready_at=?, updated_at=?, updated_by=? WHERE id=?`)
      .run(b.kind, b.host, b.path, b.format, b.version, b.notes, clearReady ? 0 : cur.ready, clearReady ? null : cur.ready_by,
        clearReady ? null : cur.ready_at, Date.now(), u.id, id);
    const before = locationOut(cur);
    const after = locationOut(db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow);
    let summary = diffSummary(before, after, ["kind", "host", "path", "format", "version", "notes"]);
    if (clearReady) summary += "; Ready withdrawn because the location changed";
    if (summary) audit({ userId: u.id, action: "update", entity: "location", entityId: id, studyId: cur.study_id, categoryId: cur.category_id, summary, before, after });
    res.json(after);
  }));

  r.post("/locations/:id/ready", h((req, res) => {
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow | undefined;
    if (!cur || cur.archived) throw new HttpError(404, "No such data location");
    const u = requirePriv(req, "locations.ready", cur.study_id);
    const { ready } = parse(z.object({ ready: z.boolean() }), req.body);
    if (!!cur.ready === ready) return res.json(locationOut(cur));
    const t = Date.now();
    db.prepare("UPDATE locations SET ready=?, ready_by=?, ready_at=?, updated_at=?, updated_by=? WHERE id=?")
      .run(ready ? 1 : 0, ready ? u.id : null, ready ? t : null, t, u.id, id);
    const after = locationOut(db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow);
    audit({ userId: u.id, action: ready ? "ready" : "unready", entity: "location", entityId: id, studyId: cur.study_id, categoryId: cur.category_id,
      summary: `${ready ? "marked Ready" : "withdrew Ready"}: ${cur.host ? cur.host + ": " : ""}${cur.path}` });
    res.json(after);
  }));

  r.post("/locations/:id/archive", h((req, res) => {
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM locations WHERE id = ?").get(id) as LocationRow | undefined;
    if (!cur || cur.archived) throw new HttpError(404, "No such data location");
    const u = requirePriv(req, "locations.edit", cur.study_id);
    db.prepare("UPDATE locations SET archived=1, ready=0, updated_at=?, updated_by=? WHERE id=?").run(Date.now(), u.id, id);
    audit({ userId: u.id, action: "archive", entity: "location", entityId: id, studyId: cur.study_id, categoryId: cur.category_id,
      summary: `removed ${cur.host ? cur.host + ": " : ""}${cur.path}`, before: locationOut(cur) });
    res.json({ ok: true });
  }));

  /** Mark a data category as not applicable to a study (or undo it). */
  r.put("/cells/:studyId/:categoryId", h((req, res) => {
    const studyId = idParam(req, "studyId"), categoryId = idParam(req, "categoryId");
    const u = requirePriv(req, "locations.edit", studyId);
    requireStudy(studyId); requireCategory(categoryId);
    const b = parse(z.object({ notApplicable: z.boolean(), note: z.string().trim().max(2000).default("") }), req.body);
    const cur = db.prepare("SELECT * FROM cell_status WHERE study_id=? AND category_id=?").get(studyId, categoryId) as CellRow | undefined;
    db.prepare(`INSERT INTO cell_status(study_id, category_id, not_applicable, note, updated_at, updated_by) VALUES (?,?,?,?,?,?)
      ON CONFLICT(study_id, category_id) DO UPDATE SET not_applicable=excluded.not_applicable, note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(studyId, categoryId, b.notApplicable ? 1 : 0, b.note, Date.now(), u.id);
    const changedNa = !!cur?.not_applicable !== b.notApplicable;
    if (changedNa || (cur?.note ?? "") !== b.note) {
      audit({ userId: u.id, action: "update", entity: "cell", studyId, categoryId,
        summary: changedNa ? (b.notApplicable ? "marked N/A for this study" : "marked applicable again") + (b.note ? `: ${b.note}` : "") : "edited the note" });
    }
    res.json(cellOut(db.prepare("SELECT * FROM cell_status WHERE study_id=? AND category_id=?").get(studyId, categoryId) as CellRow));
  }));

  /* ---------- audit ---------- */
  r.get("/audit", h((req, res) => {
    const q = parse(z.object({
      studyId: z.coerce.number().int().optional(), categoryId: z.coerce.number().int().optional(), userId: z.coerce.number().int().optional(),
      entity: z.string().max(40).optional(), entityId: z.coerce.number().int().optional(),
      before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    const where: string[] = [], args: unknown[] = [];
    if (q.studyId != null) { where.push("a.study_id = ?"); args.push(q.studyId); }
    if (q.categoryId != null) { where.push("a.category_id = ?"); args.push(q.categoryId); }
    if (q.userId != null) { where.push("a.user_id = ?"); args.push(q.userId); }
    if (q.entity) { where.push("a.entity = ?"); args.push(q.entity); }
    if (q.entityId != null) { where.push("a.entity_id = ?"); args.push(q.entityId); }
    if (q.before != null) { where.push("a.id < ?"); args.push(q.before); }
    const rows = db.prepare(`SELECT a.id, a.ts, a.user_id AS userId, a.action, a.entity, a.entity_id AS entityId, a.study_id AS studyId,
        a.category_id AS categoryId, a.summary FROM audit a ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY a.id DESC LIMIT ?`).all(...args, q.limit + 1) as { id: number }[];
    res.json({ entries: rows.slice(0, q.limit), more: rows.length > q.limit });
  }));

  return r;
}

type RoleRow2 = { id: number; name: string; description: string; privileges: string; builtin: number; updated_at: number; updated_by: number | null; n: number };
