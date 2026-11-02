/**
 * Import data paths from a CSV export of the "DEAP-Fed data paths" sheet (or any sheet shaped like it):
 * one row per study (first column = study code), one column per data category, cells holding paths.
 *
 *   - Empty cells are skipped; "N/A" marks the category not applicable for that study; "?", "??", "???" are reported and skipped.
 *   - A cell may hold several paths separated by commas or semicolons. A bare file name inherits the folder of the path before it.
 *   - Paths already recorded for that study and category are left alone, so the import can be re-run safely.
 *   - Columns are matched to categories by label or code; a few sheet headings have built-in aliases.
 *     "Tabulated imaging results" creates that category under Derived data if it doesn't exist.
 */
import fs from "node:fs";
import path from "node:path";
import { audit, db, tx } from "./db.js";

const ALIASES: Record<string, string> = {
  "tabulated demographic data": "tabulated",
  "tabulated data": "tabulated",
  "data dictionary": "dictionary",
  "raw imaging data": "mri",
  "raw imaging": "mri",
  "mri": "mri",
  "pet": "pet",
  "mmps processing results": "mmps",
  "neuroquant processing results": "neuroquant",
  "concatenated imaging results": "concat",
  "concatenated imaging data": "concat",
  "tabulated imaging results": "tabulated_imaging",
};
const AUTO_CATEGORIES: Record<string, { parent: string; label: string; description: string }> = {
  tabulated_imaging: { parent: "derived", label: "Tabulated imaging results", description: "Imaging measures (ROIs, QC) extracted from processed imaging into tables." },
};
const SKIP_COLUMNS = new Set(["study", "tre", "notes", "note", "release", "host"]);

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const norm = (p: string) => p.trim().replace(/\/+$/, "") || "/";
const isFile = (p: string) => /\.[A-Za-z0-9]{1,6}(\.gz)?$/.test(path.basename(norm(p)));
const versionOf = (p: string) => p.match(/release_archive\/(\d+)_(\d+)/)?.slice(1, 3).join(".") ?? "";

export interface ImportReport { created: string[]; skipped: string[]; notApplicable: string[]; unknown: string[]; problems: string[] }

export function importCsv(file: string, opts: { dryRun?: boolean } = {}): ImportReport {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length < 2) throw new Error("The CSV has no data rows");
  const header = rows[0].map((h) => h.trim());
  const rep: ImportReport = { created: [], skipped: [], notApplicable: [], unknown: [], problems: [] };
  const source = path.basename(file);
  const t = Date.now();

  const findCategory = (heading: string): { id: number; label: string } | null => {
    const key = heading.toLowerCase();
    const byLabel = db.prepare("SELECT id, label FROM categories WHERE lower(label) = ? OR lower(code) = ?").get(key, key) as { id: number; label: string } | undefined;
    if (byLabel) return byLabel;
    const code = ALIASES[key];
    if (!code) return null;
    const hit = db.prepare("SELECT id, label FROM categories WHERE code = ?").get(code) as { id: number; label: string } | undefined;
    if (hit) return hit;
    const auto = AUTO_CATEGORIES[code];
    if (!auto) return null;
    const parent = db.prepare("SELECT id FROM categories WHERE code = ?").get(auto.parent) as { id: number } | undefined;
    if (opts.dryRun) { rep.created.push(`category ${auto.label} (new)`); return { id: -1, label: auto.label }; }
    const order = Number((db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories WHERE parent_id IS ?").get(parent?.id ?? null) as { n: number }).n);
    const id = Number(db.prepare(`INSERT INTO categories(parent_id, code, label, description, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(parent?.id ?? null, code, auto.label, auto.description, order, t, t).lastInsertRowid);
    audit({ userId: null, action: "create", entity: "category", entityId: id, categoryId: id, summary: `added data category ${auto.label} for the import of ${source}` });
    rep.created.push(`category ${auto.label}`);
    return { id, label: auto.label };
  };

  try {
  tx(() => {
    const columns = header.map((h, i) => {
      if (i === 0 || SKIP_COLUMNS.has(h.toLowerCase()) || !h) return null;
      const c = findCategory(h);
      if (!c) rep.problems.push(`column "${h}" matches no data category; skipped`);
      return c;
    });

    for (const r of rows.slice(1)) {
      const code = (r[0] ?? "").trim();
      const study = db.prepare("SELECT id, name, release, tre, default_host FROM studies WHERE code = ? OR name = ?").get(code, code) as
        { id: number; name: string; release: string; tre: string; default_host: string } | undefined;
      if (!study) { rep.problems.push(`study "${code}" isn't in the registry; row skipped`); continue; }
      const treCol = header.findIndex((h) => h.toLowerCase() === "tre");
      const tre = treCol >= 0 ? (r[treCol] ?? "").trim() : "";
      if (tre && tre !== study.tre) {
        rep.created.push(`${code}: TRE ${study.tre || "(empty)"} → ${tre}`);
        if (!opts.dryRun) {
          db.prepare("UPDATE studies SET tre = ?, updated_at = ? WHERE id = ?").run(tre, t, study.id);
          audit({ userId: null, action: "update", entity: "study", entityId: study.id, studyId: study.id, summary: `${study.name}: tre: ${study.tre || "(empty)"} → ${tre} (from ${source})` });
        }
      }

      columns.forEach((cat, i) => {
        if (!cat) return;
        const value = (r[i] ?? "").trim();
        if (!value) return;
        const label = `${code} · ${cat.label}`;
        if (/^n\/?a$/i.test(value)) {
          rep.notApplicable.push(label);
          if (!opts.dryRun && cat.id > 0) {
            db.prepare(`INSERT INTO cell_status(study_id, category_id, not_applicable, note, updated_at) VALUES (?,?,1,?,?)
              ON CONFLICT(study_id, category_id) DO UPDATE SET not_applicable = 1, updated_at = excluded.updated_at`).run(study.id, cat.id, `from ${source}`, t);
            audit({ userId: null, action: "update", entity: "cell", studyId: study.id, categoryId: cat.id, summary: `marked N/A (from ${source})` });
          }
          return;
        }
        if (/^\?+$/.test(value)) { rep.unknown.push(label); return; }

        let lastDir = "";
        for (const part of value.split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean)) {
          const p = part.startsWith("/") || part.startsWith("~") || !lastDir ? part : path.posix.join(lastDir, part);
          if (!p.startsWith("/") && !p.startsWith("~")) rep.problems.push(`${label}: "${p}" isn't an absolute path; imported as written`);
          const kind = isFile(p) ? "file" : "directory";
          lastDir = kind === "file" ? path.posix.dirname(p) : norm(p);
          const existing = (db.prepare("SELECT path FROM locations WHERE study_id = ? AND category_id = ? AND archived = 0").all(study.id, cat.id) as { path: string }[])
            .some((l) => norm(l.path) === norm(p));
          if (existing) { rep.skipped.push(`${label}: ${p} (already recorded)`); continue; }
          rep.created.push(`${label}: ${kind} ${p}`);
          if (opts.dryRun || cat.id < 0) continue;
          const id = Number(db.prepare(`INSERT INTO locations(study_id, category_id, kind, host, path, version, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(study.id, cat.id, kind, study.default_host, norm(p) === "/" ? p : (kind === "directory" ? norm(p) : p),
              versionOf(p), `Imported from ${source}.`, t, t).lastInsertRowid);
          audit({ userId: null, action: "create", entity: "location", entityId: id, studyId: study.id, categoryId: cat.id,
            summary: `imported ${kind} ${study.default_host ? study.default_host + ": " : ""}${p} from ${source}` });
        }
      });
    }
    if (opts.dryRun) throw new DryRun();
  })();
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return rep;
}

class DryRun extends Error {}
