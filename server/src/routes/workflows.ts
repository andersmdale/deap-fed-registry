import { Router } from "express";
import { z } from "zod";
import { audit, db, diffSummary, tx } from "../db.js";
import { h, HttpError, idParam, parse, requirePriv } from "../http.js";
import { categoryLabel, locationOut, runOut, studyLabel, workflowsOut, type LocationRow, type RunRow } from "./data.js";

const wfSchema = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().trim().max(4000).default(""),
  host: z.string().trim().max(200).default(""), tool: z.string().trim().max(200).default(""), version: z.string().trim().max(80).default(""),
  command: z.string().max(8000).default(""), otherOutputs: z.string().trim().max(500).default(""), sortOrder: z.number().int().default(0),
  inputs: z.array(z.number().int()).max(100).default([]), outputs: z.array(z.number().int()).max(100).default([]),
});
const runFields = {
  status: z.enum(["completed", "running", "failed"]).default("completed"), host: z.string().trim().max(200).default(""),
  outputPath: z.string().trim().max(4000).default(""), version: z.string().trim().max(80).default(""), notes: z.string().trim().max(4000).default(""),
};

function writeIo(id: number, inputs: number[], outputs: number[]) {
  for (const c of [...inputs, ...outputs]) if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(c)) throw new HttpError(400, "Unknown data category");
  db.prepare("DELETE FROM workflow_io WHERE workflow_id = ?").run(id);
  const ins = db.prepare("INSERT OR IGNORE INTO workflow_io(workflow_id, category_id, direction) VALUES (?,?,?)");
  inputs.forEach((c) => ins.run(id, c, "in"));
  outputs.forEach((c) => ins.run(id, c, "out"));
}
const ioText = (ins: number[], outs: number[], other: string) =>
  `${ins.map(categoryLabel).join(" + ") || "—"} → ${[...outs.map(categoryLabel), other].filter(Boolean).join(" + ") || "—"}`;

export function workflowRoutes(): Router {
  const r = Router();

  r.post("/workflows", h((req, res) => {
    const u = requirePriv(req, "workflows.manage");
    const b = parse(wfSchema, req.body);
    if (!b.outputs.length && !b.otherOutputs) throw new HttpError(400, "Give the workflow at least one output");
    if (db.prepare("SELECT 1 FROM workflows WHERE name = ?").get(b.name)) throw new HttpError(409, "A workflow with that name exists");
    const t = Date.now();
    const id = tx(() => {
      const id = Number(db.prepare(`INSERT INTO workflows(name, description, host, tool, version, command, other_outputs, sort_order, created_at, created_by, updated_at, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.name, b.description, b.host, b.tool, b.version, b.command, b.otherOutputs, b.sortOrder, t, u.id, t, u.id).lastInsertRowid);
      writeIo(id, b.inputs, b.outputs);
      audit({ userId: u.id, action: "create", entity: "workflow", entityId: id, summary: `added workflow ${b.name}: ${ioText(b.inputs, b.outputs, b.otherOutputs)}`, after: b });
      return id;
    })();
    res.json(workflowsOut(true).find((w) => w.id === id));
  }));

  r.put("/workflows/:id", h((req, res) => {
    const u = requirePriv(req, "workflows.manage");
    const id = idParam(req);
    const before = workflowsOut(true).find((w) => w.id === id);
    if (!before) throw new HttpError(404, "No such workflow");
    const b = parse(wfSchema.extend({ archived: z.boolean().default(false) }), req.body);
    if (!b.outputs.length && !b.otherOutputs) throw new HttpError(400, "Give the workflow at least one output");
    if (db.prepare("SELECT 1 FROM workflows WHERE name = ? AND id != ?").get(b.name, id)) throw new HttpError(409, "A workflow with that name exists");
    tx(() => {
      db.prepare(`UPDATE workflows SET name=?, description=?, host=?, tool=?, version=?, command=?, other_outputs=?, sort_order=?, archived=?, updated_at=?, updated_by=? WHERE id=?`)
        .run(b.name, b.description, b.host, b.tool, b.version, b.command, b.otherOutputs, b.sortOrder, b.archived ? 1 : 0, Date.now(), u.id, id);
      writeIo(id, b.inputs, b.outputs);
      const after = workflowsOut(true).find((w) => w.id === id)!;
      const io = (w: { inputs: number[]; outputs: number[]; otherOutputs: string }) => ioText(w.inputs, w.outputs, w.otherOutputs);
      let summary = diffSummary(before, after, ["name", "description", "host", "tool", "version", "command", "sortOrder", "archived"]);
      if (io(before) !== io(after)) summary += (summary ? "; " : "") + `inputs/outputs: ${io(before)} ⇒ ${io(after)}`;
      if (summary) audit({ userId: u.id, action: before.archived !== after.archived ? (after.archived ? "archive" : "restore") : "update",
        entity: "workflow", entityId: id, summary: `${before.name}: ${summary}`, before, after });
    })();
    res.json(workflowsOut(true).find((w) => w.id === id));
  }));

  /** Record a run: snapshot its inputs and, optionally, register its output location under the output categories. */
  r.post("/runs", h((req, res) => {
    const b = parse(z.object({
      workflowId: z.number().int(), studyId: z.number().int(), ...runFields,
      createOutputs: z.array(z.object({ categoryId: z.number().int(), kind: z.enum(["directory", "file"]).default("directory") })).max(50).default([]),
    }), req.body);
    const u = requirePriv(req, "runs.record", b.studyId);
    const wf = workflowsOut(true).find((w) => w.id === b.workflowId);
    if (!wf) throw new HttpError(400, "Unknown workflow");
    if (!db.prepare("SELECT 1 FROM studies WHERE id = ?").get(b.studyId)) throw new HttpError(400, "Unknown study");
    for (const o of b.createOutputs) {
      if (!wf.outputs.includes(o.categoryId)) throw new HttpError(400, `${categoryLabel(o.categoryId)} isn't an output of ${wf.name}`);
    }
    if (b.createOutputs.length && !b.outputPath) throw new HttpError(400, "Enter the output location to record it as data");
    if (b.createOutputs.length) requirePriv(req, "locations.edit", b.studyId);
    const t = Date.now();
    const out = tx(() => {
      const locs = wf.inputs.length
        ? db.prepare(`SELECT * FROM locations WHERE archived = 0 AND study_id = ? AND category_id IN (${wf.inputs.map(() => "?").join(",")})`)
          .all(b.studyId, ...wf.inputs) as LocationRow[]
        : [];
      const inputs = {
        categories: wf.inputs,
        locations: locs.map((l) => ({ locationId: l.id, categoryId: l.category_id, updatedAt: l.updated_at, host: l.host, path: l.path, ready: !!l.ready })),
      };
      const runId = Number(db.prepare(`INSERT INTO runs(workflow_id, study_id, status, host, output_path, version, notes, inputs, created_at, created_by, updated_at, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.workflowId, b.studyId, b.status, b.host, b.outputPath, b.version, b.notes, JSON.stringify(inputs), t, u.id, t, u.id).lastInsertRowid);
      audit({ userId: u.id, action: "run", entity: "run", entityId: runId, studyId: b.studyId,
        summary: `recorded a ${b.status} ${wf.name} run for ${studyLabel(b.studyId)}${b.outputPath ? ` → ${b.host ? b.host + ": " : ""}${b.outputPath}` : ""}` +
          (locs.some((l) => !l.ready) ? ` (${locs.filter((l) => !l.ready).length} input location(s) not Ready)` : "") });
      const created = [];
      for (const o of b.createOutputs) {
        const locId = Number(db.prepare(`INSERT INTO locations(study_id, category_id, kind, host, path, version, notes, produced_by_run, created_at, created_by, updated_at, updated_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.studyId, o.categoryId, o.kind, b.host, b.outputPath, b.version, `Output of ${wf.name} run #${runId}`, runId, t, u.id, t, u.id).lastInsertRowid);
        const loc = locationOut(db.prepare("SELECT * FROM locations WHERE id = ?").get(locId) as LocationRow);
        audit({ userId: u.id, action: "create", entity: "location", entityId: locId, studyId: b.studyId, categoryId: o.categoryId,
          summary: `added ${o.kind} ${b.host ? b.host + ": " : ""}${b.outputPath} from ${wf.name} run #${runId}`, after: loc });
        created.push(loc);
      }
      return { run: runOut(db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow), locations: created };
    })();
    res.json(out);
  }));

  r.put("/runs/:id", h((req, res) => {
    const id = idParam(req);
    const cur = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!cur) throw new HttpError(404, "No such run");
    const u = requirePriv(req, "runs.record", cur.study_id);
    const b = parse(z.object(runFields), req.body);
    const before = runOut(cur);
    db.prepare("UPDATE runs SET status=?, host=?, output_path=?, version=?, notes=?, updated_at=?, updated_by=? WHERE id=?")
      .run(b.status, b.host, b.outputPath, b.version, b.notes, Date.now(), u.id, id);
    const after = runOut(db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow);
    const summary = diffSummary(before, after, ["status", "host", "outputPath", "version", "notes"]);
    if (summary) audit({ userId: u.id, action: "update", entity: "run", entityId: id, studyId: cur.study_id, summary: `run #${id}: ${summary}`, before, after });
    res.json(after);
  }));

  return r;
}
