import type { Category, Location, Me, Privilege, RegistryState, Run, Study, Workflow } from "./types";

export type CellStatus = "ready" | "partial" | "pending" | "stale" | "missing" | "na";
export const STATUS_LABEL: Record<CellStatus, string> = {
  ready: "Ready", partial: "Partly ready", pending: "Recorded", stale: "Inputs changed", missing: "No path", na: "N/A",
};

const SCOPED: Privilege[] = ["locations.edit", "locations.ready", "runs.record"];

export function can(me: Me | null, p: Privilege, studyId?: number | null): boolean {
  if (!me || !me.privileges.includes(p)) return false;
  if (studyId == null || !SCOPED.includes(p) || me.studyScope === "*") return true;
  return me.studyScope.includes(studyId);
}

export const studyLabel = (s: Study | undefined) => (s ? s.name + (s.release ? " " + s.release : "") : "Unknown study");
export const cellKey = (studyId: number, categoryId: number) => `${studyId}:${categoryId}`;
export const where = (l: { host: string; path: string }) => (l.host ? `${l.host}: ` : "") + l.path;

/** Top-level groups and the leaf categories the grid shows under each. */
export function categoryTree(cats: Category[], includeArchived = false) {
  const live = cats.filter((c) => includeArchived || !c.archived);
  const groups = live.filter((c) => c.parentId == null).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  return groups.map((g) => {
    const kids = live.filter((c) => c.parentId === g.id).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
    return { group: g, leaves: kids.length ? kids : [g] };
  });
}
export function leafCategories(cats: Category[]): Category[] {
  return categoryTree(cats).flatMap((t) => t.leaves);
}

export interface Derived {
  studies: Map<number, Study>;
  categories: Map<number, Category>;
  workflows: Map<number, Workflow>;
  runs: Map<number, Run>;
  locationsByCell: Map<string, Location[]>;
  locations: Map<number, Location>;
  na: Map<string, { notApplicable: boolean; note: string }>;
  people: Map<number, string>;
}

export function derive(s: RegistryState): Derived {
  const locationsByCell = new Map<string, Location[]>();
  for (const l of s.locations) {
    const k = cellKey(l.studyId, l.categoryId);
    const arr = locationsByCell.get(k);
    if (arr) arr.push(l); else locationsByCell.set(k, [l]);
  }
  return {
    studies: new Map(s.studies.map((x) => [x.id, x])),
    categories: new Map(s.categories.map((x) => [x.id, x])),
    workflows: new Map(s.workflows.map((x) => [x.id, x])),
    runs: new Map(s.runs.map((x) => [x.id, x])),
    locations: new Map(s.locations.map((x) => [x.id, x])),
    locationsByCell,
    na: new Map(s.cells.map((c) => [cellKey(c.studyId, c.categoryId), { notApplicable: c.notApplicable, note: c.note }])),
    people: new Map(s.people.map((p) => [p.id, p.displayName])),
  };
}

export function personName(d: Derived, me: Me | null, id: number | null | undefined): string {
  if (id == null) return "System";
  if (me && id === me.id) return "You";
  return d.people.get(id) ?? `user #${id}`;
}

/** What changed among a run's inputs since it was recorded: edited, removed, or newly added input locations. */
export function runInputChanges(d: Derived, run: Run): { changed: Location[]; removed: number; added: Location[] } {
  const snap = run.inputs?.locations ?? [];
  const changed: Location[] = [];
  let removed = 0;
  for (const s of snap) {
    const cur = d.locations.get(s.locationId);
    if (!cur) removed++;
    else if (cur.updatedAt > s.updatedAt) changed.push(cur);
  }
  const known = new Set(snap.map((s) => s.locationId));
  const added: Location[] = [];
  for (const c of run.inputs?.categories ?? []) {
    for (const l of d.locationsByCell.get(cellKey(run.studyId, c)) ?? []) {
      if (!known.has(l.id) && l.createdAt > run.createdAt) added.push(l);
    }
  }
  return { changed, removed, added };
}

export function locationStale(d: Derived, l: Location): boolean {
  if (!l.producedByRun) return false;
  const run = d.runs.get(l.producedByRun);
  if (!run) return false;
  const c = runInputChanges(d, run);
  return c.changed.length + c.removed + c.added.length > 0;
}

export function cellStatus(d: Derived, studyId: number, categoryId: number): CellStatus {
  const k = cellKey(studyId, categoryId);
  if (d.na.get(k)?.notApplicable) return "na";
  const locs = d.locationsByCell.get(k) ?? [];
  if (!locs.length) return "missing";
  if (locs.some((l) => locationStale(d, l))) return "stale";
  const ready = locs.filter((l) => l.ready).length;
  if (ready === locs.length) return "ready";
  return ready ? "partial" : "pending";
}

/** Input categories of the workflows that produce `categoryId`. */
export function upstreamCategories(workflows: Workflow[], categoryId: number): { workflow: Workflow; inputs: number[] }[] {
  return workflows.filter((w) => !w.archived && w.outputs.includes(categoryId)).map((w) => ({ workflow: w, inputs: w.inputs }));
}
export function downstreamWorkflows(workflows: Workflow[], categoryId: number): Workflow[] {
  return workflows.filter((w) => !w.archived && w.inputs.includes(categoryId));
}

export function when(ts: number | null | undefined): string {
  if (!ts) return "";
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
export const fullDate = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : "");
