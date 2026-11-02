import { useMemo, useState } from "react";
import { post, put } from "../api";
import { Chip, ConfirmButton, CopyButton, Empty, Field, History, Panel } from "../components/ui";
import {
  can, cellKey, cellStatus, categoryTree, downstreamWorkflows, locationStale, personName, runInputChanges, STATUS_LABEL,
  studyLabel, upstreamCategories, when, where, type CellStatus,
} from "../model";
import { useStore } from "../store";
import type { Location } from "../types";

type Filter = "all" | "attention" | "ready";

export function DataPage() {
  const { state, d } = useStore();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem("registry.filter") as Filter) || "all");
  const [open, setOpen] = useState<{ studyId: number; categoryId: number } | null>(null);
  if (!state || !d) return null;

  const tree = categoryTree(state.categories);
  const leaves = tree.flatMap((t) => t.leaves);
  const studies = state.studies.filter((s) => !s.archived);
  const needle = q.trim().toLowerCase();

  const rows = studies.filter((s) => {
    const sts = leaves.map((c) => cellStatus(d, s.id, c.id));
    if (filter === "attention" && !sts.some((x) => x === "stale" || x === "pending" || x === "partial" || x === "missing")) return false;
    if (filter === "ready" && !sts.some((x) => x === "ready")) return false;
    if (!needle) return true;
    if (`${s.name} ${s.code} ${s.release} ${s.tre} ${s.defaultHost}`.toLowerCase().includes(needle)) return true;
    return leaves.some((c) => (d.locationsByCell.get(cellKey(s.id, c.id)) ?? []).some((l) => `${l.host} ${l.path}`.toLowerCase().includes(needle)));
  });

  const setF = (f: Filter) => { setFilter(f); try { localStorage.setItem("registry.filter", f); } catch { /* ignore */ } };

  return (
    <section>
      <div className="bar">
        <input className="grow" type="search" placeholder="Filter by study, path or host" aria-label="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Show" value={filter} onChange={(e) => setF(e.target.value as Filter)}>
          <option value="all">All studies</option>
          <option value="attention">Needs attention</option>
          <option value="ready">Has Ready data</option>
        </select>
      </div>
      {!studies.length ? <Empty>No studies yet. Add them on the Studies page.</Empty> : (
        <div className="scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th rowSpan={2} className="sticky-col">Study</th>
                {tree.map((t) => <th key={t.group.id} colSpan={t.leaves.length} className="group">{t.group.label}</th>)}
              </tr>
              <tr>
                {leaves.map((c) => {
                  let n = 0, r = 0;
                  for (const s of studies) { const st = cellStatus(d, s.id, c.id); if (st === "na") continue; n++; if (st === "ready") r++; }
                  return <th key={c.id} className="dt" title={c.description}>{c.label}<span className="cnt">{r} of {n} ready</span></th>;
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="st sticky-col">
                    <b>{studyLabel(s)}</b>
                    <span className="meta">{[s.tre, s.access === "sumstats" ? "summary statistics only" : null, s.defaultHost].filter(Boolean).join(" · ")}</span>
                  </td>
                  {leaves.map((c) => {
                    const st = cellStatus(d, s.id, c.id);
                    const locs = d.locationsByCell.get(cellKey(s.id, c.id)) ?? [];
                    const first = locs[0];
                    const p = first ? where(first) : "";
                    return (
                      <td key={c.id}>
                        <button className="cell" onClick={() => setOpen({ studyId: s.id, categoryId: c.id })} aria-label={`${studyLabel(s)}, ${c.label}: ${STATUS_LABEL[st]}`}>
                          <Chip status={st} />
                          {p && <span className="p">{p.length > 60 ? "…" + p.slice(-58) : p}</span>}
                          {locs.length > 1 && <span className="more">+{locs.length - 1} more</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={leaves.length + 1}><Empty>No studies match this filter.</Empty></td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Legend />
      {open && <CellPanel {...open} onClose={() => setOpen(null)} onOpen={(categoryId) => setOpen({ studyId: open.studyId, categoryId })} />}
    </section>
  );
}

function Legend() {
  const items: [CellStatus, string][] = [
    ["ready", "every location signed off"], ["partial", "some locations signed off"], ["pending", "recorded, not signed off"],
    ["stale", "an input changed after a run produced this"], ["missing", ""], ["na", "doesn't exist for this study"],
  ];
  return (
    <p className="legend">
      {items.map(([s, t]) => <span key={s}><Chip status={s} />{t && <span className="note"> {t}</span>}</span>)}
    </p>
  );
}

function CellPanel({ studyId, categoryId, onClose, onOpen }: { studyId: number; categoryId: number; onClose: () => void; onOpen: (c: number) => void }) {
  const { state, d, act } = useStore();
  const [adding, setAdding] = useState(false);
  const [rev, setRev] = useState(0);
  const study = d!.studies.get(studyId)!, cat = d!.categories.get(categoryId)!;
  const me = state!.me;
  const locs = d!.locationsByCell.get(cellKey(studyId, categoryId)) ?? [];
  const na = d!.na.get(cellKey(studyId, categoryId));
  const edit = can(me, "locations.edit", studyId);
  const status = cellStatus(d!, studyId, categoryId);
  const ups = upstreamCategories(state!.workflows, categoryId);
  const downs = downstreamWorkflows(state!.workflows, categoryId);
  const bump = () => setRev((r) => r + 1);

  const parent = cat.parentId ? d!.categories.get(cat.parentId)?.label : null;
  return (
    <Panel title={`${studyLabel(study)} · ${cat.label}`} subtitle={<>{parent ? `${parent} · ` : ""}<Chip status={status} /></>} onClose={onClose}>
      {cat.description && <p className="note">{cat.description}</p>}

      <section className="stack">
        <h3>Locations</h3>
        {!locs.length && !na?.notApplicable && <div className="note">No paths recorded yet.</div>}
        {locs.map((l) => <LocationCard key={l.id} loc={l} onChanged={bump} />)}
        {edit && !na?.notApplicable && (adding
          ? <LocationForm studyId={studyId} categoryId={categoryId} defaultHost={study.defaultHost} onDone={() => { setAdding(false); bump(); }} onCancel={() => setAdding(false)} />
          : <div><button onClick={() => setAdding(true)}>Add a path</button></div>)}
        {!edit && <div className="note">You can view these records. Your role doesn't let you edit {studyLabel(study)} paths.</div>}
      </section>

      <section className="stack">
        <label className="ck">
          <input type="checkbox" checked={!!na?.notApplicable} disabled={!edit}
            onChange={(e) => act(() => put(`/cells/${studyId}/${categoryId}`, { notApplicable: e.target.checked, note: na?.note ?? "" }), e.target.checked ? "Marked N/A" : "Marked applicable").then(bump)} />
          {cat.label} doesn't exist for {studyLabel(study)} (N/A)
        </label>
      </section>

      {(ups.length > 0 || downs.length > 0) && (
        <section className="stack">
          <h3>Dependencies</h3>
          {ups.map(({ workflow, inputs }) => (
            <div key={workflow.id} className="dep">
              <div className="note">Produced by <b>{workflow.name}</b> from:</div>
              {inputs.length ? inputs.map((cid) => {
                const st = cellStatus(d!, studyId, cid);
                return <div key={cid} className="flow"><Chip status={st} /><button className="link" onClick={() => onOpen(cid)}>{d!.categories.get(cid)?.label}</button></div>;
              }) : <div className="note">no tracked inputs</div>}
            </div>
          ))}
          {downs.length > 0 && (
            <div className="note">Feeds into {downs.map((w, i) => <span key={w.id}>{i ? ", " : ""}<b>{w.name}</b></span>)}.</div>
          )}
        </section>
      )}

      <section className="stack">
        <h3>History</h3>
        <History query={`studyId=${studyId}&categoryId=${categoryId}`} refreshKey={`${rev}:${locs.map((l) => l.updatedAt).join(",")}`} />
      </section>
    </Panel>
  );
}

function LocationCard({ loc, onChanged }: { loc: Location; onChanged: () => void }) {
  const { state, d, act } = useStore();
  const [editing, setEditing] = useState(false);
  const me = state!.me;
  const edit = can(me, "locations.edit", loc.studyId);
  const ready = can(me, "locations.ready", loc.studyId);
  const run = loc.producedByRun ? d!.runs.get(loc.producedByRun) : undefined;
  const wf = run ? d!.workflows.get(run.workflowId) : undefined;
  const stale = locationStale(d!, loc);
  const changes = run ? runInputChanges(d!, run) : null;
  const notReadyInputs = useMemo(() => {
    const ups = upstreamCategories(state!.workflows, loc.categoryId).flatMap((u) => u.inputs);
    return [...new Set(ups)].filter((c) => { const s = cellStatus(d!, loc.studyId, c); return s !== "ready" && s !== "na"; });
  }, [state, d, loc]);

  if (editing) return <LocationForm loc={loc} studyId={loc.studyId} categoryId={loc.categoryId} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;

  return (
    <div className={`loc ${loc.ready ? "is-ready" : ""}`}>
      <div className="loc-head">
        <span className="tag">{loc.kind}</span>
        {loc.ready ? <Chip status="ready" /> : <Chip status="pending">Not signed off</Chip>}
        {stale && <Chip status="stale" />}
      </div>
      <div className="mono path">{where(loc)}</div>
      <div className="kvs">
        {loc.format && <span>Format <b>{loc.format}</b></span>}
        {loc.version && <span>Version <b>{loc.version}</b></span>}
        {loc.ready && <span>Ready since <b>{when(loc.readyAt)}</b>, signed off by <b>{personName(d!, me, loc.readyBy)}</b></span>}
        <span>Edited by {personName(d!, me, loc.updatedBy)}, {when(loc.updatedAt)}</span>
      </div>
      {loc.notes && <div className="notes">{loc.notes}</div>}
      {run && wf && (
        <div className="note">Produced by the {wf.name} run #{run.id}, recorded {when(run.createdAt)} by {personName(d!, me, run.createdBy)}.</div>
      )}
      {stale && changes && (
        <div className="banner warn">
          Since that run: {[changes.changed.length && `${changes.changed.length} input location(s) edited`, changes.removed && `${changes.removed} removed`,
            changes.added.length && `${changes.added.length} added`].filter(Boolean).join(", ")}. Re-run the workflow or confirm this output still holds.
        </div>
      )}
      <div className="actions">
        {ready && (loc.ready
          ? <ConfirmButton label="Withdraw Ready" confirm="Withdraw the Ready sign-off for this location?" onConfirm={() => act(() => post(`/locations/${loc.id}/ready`, { ready: false }), "Ready withdrawn").then(onChanged)} />
          : <ConfirmButton className="ready" label="Mark Ready"
              confirm={<>Confirm that the data at <span className="mono">{where(loc)}</span> is complete and ready to use.
                {notReadyInputs.length > 0 && <div className="warn-text">Not all inputs are Ready: {notReadyInputs.map((c) => d!.categories.get(c)?.label).join(", ")}.</div>}</>}
              onConfirm={() => act(() => post(`/locations/${loc.id}/ready`, { ready: true }), "Marked Ready").then(onChanged)} />)}
        {edit && <button onClick={() => setEditing(true)}>Edit</button>}
        <CopyButton text={loc.path} />
        {edit && <ConfirmButton className="danger" label="Remove" confirm="Remove this location? It stays in the history."
          onConfirm={() => act(() => post(`/locations/${loc.id}/archive`), "Location removed").then(onChanged)} />}
      </div>
    </div>
  );
}

function LocationForm({ loc, studyId, categoryId, defaultHost = "", onDone, onCancel }: {
  loc?: Location; studyId: number; categoryId: number; defaultHost?: string; onDone: () => void; onCancel: () => void;
}) {
  const { act } = useStore();
  const [f, setF] = useState({
    kind: loc?.kind ?? "directory", host: loc?.host ?? defaultHost, path: loc?.path ?? "", format: loc?.format ?? "",
    version: loc?.version ?? "", notes: loc?.notes ?? "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const moving = loc && loc.ready && (f.path !== loc.path || f.host !== loc.host || f.kind !== loc.kind);
  const save = async () => {
    const ok = await act(() => (loc ? put(`/locations/${loc.id}`, f) : post("/locations", { ...f, studyId, categoryId })), loc ? "Saved" : "Path added");
    if (ok) onDone();
  };
  return (
    <div className="loc editing stack">
      <div className="two">
        <Field label="Type">{(id) => (
          <select id={id} value={f.kind} onChange={set("kind")}><option value="directory">Directory</option><option value="file">File</option></select>)}
        </Field>
        <Field label="Host / filesystem">{(id) => <input id={id} value={f.host} onChange={set("host")} placeholder="beast2, Mac Pro, UKB RAP…" />}</Field>
      </div>
      <Field label="Path">{(id) => <textarea id={id} className="mono" rows={2} value={f.path} onChange={set("path")} placeholder="/space/ceph/1/…" />}</Field>
      <div className="two">
        <Field label="Format">{(id) => <input id={id} value={f.format} onChange={set("format")} placeholder="DICOM, NIfTI, PLINK, parquet…" />}</Field>
        <Field label="Release / version">{(id) => <input id={id} value={f.version} onChange={set("version")} />}</Field>
      </div>
      <Field label="Notes">{(id) => <textarea id={id} rows={2} value={f.notes} onChange={set("notes")} />}</Field>
      {moving && <div className="banner warn">Changing the location withdraws its Ready sign-off.</div>}
      <div className="actions">
        <button className="primary" onClick={save} disabled={!f.path.trim()}>{loc ? "Save changes" : "Add path"}</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
