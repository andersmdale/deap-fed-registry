import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_PRESETS } from "./privileges.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Data directory: REGISTRY_DATA, else the path in <repo>/.registry-data (written by the installer), else <repo>/data.
 *  Holds the database, the setup token, backups and the log. */
const pointer = path.join(here, "../../.registry-data");
export const DATA_DIR = path.resolve(process.env.REGISTRY_DATA
  || (fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : "")
  || path.join(here, "../../data"));
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Node's built-in SQLite (no native add-on to compile). */
const raw = new DatabaseSync(process.env.REGISTRY_DB || path.join(DATA_DIR, "registry.db"));
raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

type Param = string | number | bigint | null | Uint8Array;
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Thin wrapper: rows come back untyped so each query casts to its own row shape. */
export const db = {
  exec: (sql: string) => raw.exec(sql),
  prepare(sql: string) {
    const st = raw.prepare(sql);
    return {
      run: (...args: Param[]) => st.run(...args),
      get: (...args: Param[]): any => st.get(...args),
      all: (...args: unknown[]): any[] => st.all(...(args as Param[])),
    };
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Wrap `fn` in BEGIN/COMMIT, rolling back if it throws. Nested calls join the outer transaction. */
let depth = 0;
export function tx<T>(fn: () => T): () => T {
  return () => {
    if (depth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    depth++;
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      depth--;
    }
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  privileges TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role_id INTEGER NOT NULL REFERENCES roles(id),
  study_scope TEXT NOT NULL DEFAULT '"*"',
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS studies(
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  release TEXT NOT NULL DEFAULT '',
  tre TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT 'tre',
  default_host TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES categories(id),
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS workflows(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  other_outputs TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS workflow_io(
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  PRIMARY KEY(workflow_id, category_id, direction));

CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  study_id INTEGER NOT NULL REFERENCES studies(id),
  status TEXT NOT NULL DEFAULT 'completed',
  host TEXT NOT NULL DEFAULT '',
  output_path TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  inputs TEXT NOT NULL DEFAULT '{"categories":[],"locations":[]}',
  created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS locations(
  id INTEGER PRIMARY KEY,
  study_id INTEGER NOT NULL REFERENCES studies(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  kind TEXT NOT NULL DEFAULT 'directory' CHECK(kind IN ('directory','file')),
  host TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  ready INTEGER NOT NULL DEFAULT 0,
  ready_by INTEGER,
  ready_at INTEGER,
  produced_by_run INTEGER REFERENCES runs(id),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, created_by INTEGER, updated_at INTEGER NOT NULL, updated_by INTEGER);

CREATE TABLE IF NOT EXISTS cell_status(
  study_id INTEGER NOT NULL REFERENCES studies(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  not_applicable INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL, updated_by INTEGER,
  PRIMARY KEY(study_id, category_id));

CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  study_id INTEGER,
  category_id INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  before TEXT,
  after TEXT);

CREATE INDEX IF NOT EXISTS locations_cell ON locations(study_id, category_id);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS audit_entity ON audit(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_cell ON audit(study_id, category_id);
CREATE INDEX IF NOT EXISTS runs_study ON runs(study_id, workflow_id);
`;

export function migrate(): void {
  db.exec(SCHEMA);
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version < 1) {
    tx(seed)();
    db.exec("PRAGMA user_version = 1");
  }
}

/** First-run contents: roles, data categories, the DEAP-Fed studies and the paths already known. */
function seed(): void {
  const now = Date.now();
  const role = db.prepare("INSERT INTO roles(name, description, privileges, builtin, created_at, updated_at) VALUES (?,?,?,1,?,?)");
  for (const r of Object.values(ROLE_PRESETS)) role.run(r.name, r.description, JSON.stringify(r.privileges), now, now);

  const cat = db.prepare("INSERT INTO categories(parent_id, code, label, description, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
  const catId: Record<string, number> = {};
  const addCat = (parent: string | null, code: string, label: string, description: string, order: number) => {
    catId[code] = Number(cat.run(parent ? catId[parent] : null, code, label, description, order, now, now).lastInsertRowid);
  };
  addCat(null, "raw", "Raw data", "Data as downloaded from each study.", 1);
  addCat("raw", "tabulated", "Tabulated data", "Non-imaging tables (phenotypes, assessments, demographics).", 1);
  addCat("raw", "dictionary", "Data dictionary", "Data dictionary for the tabulated data.", 2);
  addCat("raw", "mri", "MRI scans", "Raw MRI (DICOM, NIfTI or k-space as released).", 3);
  addCat("raw", "pet", "PET scans", "Raw PET images.", 4);
  addCat("raw", "genetics", "Genotyping / sequencing", "Genotype arrays, imputed genotypes, WGS or WES.", 5);
  addCat(null, "derived", "Derived data", "Results computed from the raw data.", 2);
  addCat("derived", "mmps", "MMPS results", "MMPS-processed imaging.", 1);
  addCat("derived", "neuroquant", "NeuroQuant results", "NeuroQuant segmentation outputs.", 2);
  addCat("derived", "atlas", "Atlas-registered MMPS", "MMPS results registered to atlas space.", 3);
  addCat("derived", "concat", "Concatenated imaging", "Vertexwise and voxelwise results concatenated across subjects and visits.", 4);
  addCat("derived", "svd", "SVD of concatenated imaging", "Singular value decomposition of the concatenated data.", 5);

  const st = db.prepare(`INSERT INTO studies(code, name, release, tre, access, default_host, description, sort_order, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const studyId: Record<string, number> = {};
  const studies: [string, string, string, string, string][] = [
    ["ABCD", "ABCD", "tre-nbdc", "beast2", "Release archive /space/ceph/1/ABCD/data/release_archive (6_1, 7_0). DEAP-Fed is moving to 7.0."],
    ["HBCD", "HBCD", "tre-nbdc", "beast2", ""],
    ["UKB", "UK Biobank", "tre-ukb", "JCVI local server", ""],
    ["ADNI", "ADNI", "tre-adni", "JCVI local server", ""],
    ["FLENI", "FLENI", "tre-fleni", "", "Instituto Neurológico Fleni / Arg-ADNI. Assumed to have the same data types as ADNI."],
    ["PING", "PING", "tre-ping", "JCVI local server", ""],
    ["VETSA", "VETSA", "tre-vetsa", "JCVI local server", ""],
    ["HCP-YA", "HCP-YA", "tre-hcpya", "JCVI local server", ""],
    ["PPMI", "PPMI", "tre-ppmi", "JCVI local server", ""],
    ["HUNT", "HUNT", "tre-hunt", "", ""],
    ["TOP", "TOP", "tre-top", "", ""],
  ];
  studies.forEach(([code, name, tre, host, desc], i) => {
    studyId[code] = Number(st.run(code, name, "", tre, "tre", host, desc, i + 1, now, now).lastInsertRowid);
  });

  const loc = db.prepare(`INSERT INTO locations(study_id, category_id, kind, host, path, format, version, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const R = "/space/ceph/1/ABCD/data/release_archive";
  loc.run(studyId.ABCD, catId.tabulated, "directory", "beast2", `${R}/7_0`, "NBDC release tables", "7.0", "Release root.", now, now);
  loc.run(studyId.ABCD, catId.tabulated, "directory", "beast2", `${R}/6_1`, "NBDC release tables", "6.1", "Release root.", now, now);
  loc.run(studyId.ABCD, catId.concat, "directory", "beast2", `${R}/6_1/concatenated/imaging`, "MMPS concatenated .mat", "6.1",
    "Vertexwise and voxelwise. Used by the standing FEMA workers on tre-nbdc.", now, now);
  for (const code of ["ABCD", "HBCD", "UKB", "ADNI", "PING"]) {
    loc.run(studyId[code], catId.dictionary, "file", "Mac Pro (DEAP-Fed server)",
      `~/Dropbox/github/deap-fed/server/config/dictionaries/${code}.json.gz`, "DEAP-Fed dictionary (json.gz)", "",
      "DEAP-Fed's built copy; not yet checked against the study's own dictionary.", now, now);
  }

  const wf = db.prepare(`INSERT INTO workflows(name, description, host, tool, command, other_outputs, sort_order, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const io = db.prepare("INSERT INTO workflow_io(workflow_id, category_id, direction) VALUES (?,?,?)");
  const addWf = (name: string, desc: string, host: string, tool: string, cmd: string, other: string, order: number, ins: string[], outs: string[]) => {
    const id = Number(wf.run(name, desc, host, tool, cmd, other, order, now, now).lastInsertRowid);
    ins.forEach((c) => io.run(id, catId[c], "in"));
    outs.forEach((c) => io.run(id, catId[c], "out"));
  };
  addWf("MMPS processing", "Structural, diffusion and functional processing of raw MRI with MMPS.", "", "MMPS", "", "", 1, ["mri"], ["mmps"]);
  addWf("NeuroQuant processing", "Volumetric segmentation of T1 images with NeuroQuant.", "", "NeuroQuant", "", "", 2, ["mri"], ["neuroquant"]);
  addWf("Atlas registration", "Register MMPS results to atlas space.", "", "MMPS", "", "", 3, ["mmps"], ["atlas"]);
  addWf("Concatenation", "Concatenate vertexwise and voxelwise results across subjects and visits, for FEMA.", "beast2 (Slurm)", "", "", "", 4, ["atlas"], ["concat"]);
  addWf("SVD", "Singular value decomposition of the concatenated imaging data.", "beast2 (Slurm)", "", "", "", 5, ["concat"], ["svd"]);
  addWf("DEAP-Fed import", "Import the study into the format its DEAP-Fed TRE client reads.", "beast2", "deap_fed_client.importers",
    "python -m deap_fed_client.importers <STUDY> --release <dir> --write", "DEAP-Fed TRE tables (tre_data)", 6,
    ["tabulated", "dictionary", "concat"], []);

  db.prepare("INSERT INTO audit(ts, user_id, action, entity, summary) VALUES (?,?,?,?,?)").run(
    now, null, "setup", "registry",
    "Registry created with 11 studies, 12 data categories, the known ABCD paths, 5 DEAP-Fed dictionary locations and 6 workflows. Nothing marked Ready.");
}

export const now = () => Date.now();

/** Write one audit row. `before`/`after` are stored as JSON for the record's history. */
export function audit(e: {
  userId: number | null; action: string; entity: string; entityId?: number | null;
  studyId?: number | null; categoryId?: number | null; summary: string; before?: unknown; after?: unknown;
}): void {
  db.prepare(`INSERT INTO audit(ts, user_id, action, entity, entity_id, study_id, category_id, summary, before, after)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    Date.now(), e.userId, e.action, e.entity, e.entityId ?? null, e.studyId ?? null, e.categoryId ?? null, e.summary,
    e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after));
}

/** Describe changed fields between two records, e.g. `path: /a → /b; host: x → y`. */
export function diffSummary(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): string {
  const show = (v: unknown) => (v === "" || v == null ? "(empty)" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));
  return fields.filter((f) => (before[f] ?? "") !== (after[f] ?? ""))
    .map((f) => (f === "notes" || f === "description" || f === "command" ? `${f} edited` : `${f}: ${show(before[f])} → ${show(after[f])}`))
    .join("; ");
}
