import { useState } from "react";
import { post, put } from "../api";
import { Chip, Empty, Field, History, Panel } from "../components/ui";
import { can, cellKey, cellStatus, leafCategories, personName, runInputChanges, studyLabel, when, where } from "../model";
import { useStore } from "../store";
import type { Run, Workflow } from "../types";

export function WorkflowsPage() {
  const { state, d } = useStore();
  const [editWf, setEditWf] = useState<Workflow | "new" | null>(null);
  const [runFor, setRunFor] = useState<{ wf: Workflow; run: Run | null } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  if (!state || !d) return null;
  const manage = can(state.me, "workflows.manage");
  const record = can(state.me, "runs.record");
  const label = (id: number) => d.categories.get(id)?.label ?? "?";
  const wfs = state.workflows.filter((w) => showArchived || !w.archived);
  return (
    <section>
      <div className="bar">
        <p className="note grow">Each workflow reads some data categories and writes others. Recording a run saves the state of its inputs, so its outputs are flagged when an input changes later.</p>
        <label className="ck"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {manage && <button className="primary" onClick={() => setEditWf("new")}>Add workflow</button>}
      </div>
      {!wfs.length && <Empty>No workflows defined yet.</Empty>}
      <div className="cards">
        {wfs.map((w) => {
          const runs = state.runs.filter((r) => r.workflowId === w.id).slice(0, 25);
          return (
            <article className={`card ${w.archived ? "archived" : ""}`} key={w.id}>
              <div className="row-between">
                <h3>{w.name}</h3>
                <div className="actions">
                  {record && !w.archived && <button className="primary small" onClick={() => setRunFor({ wf: w, run: null })}>Record run</button>}
                  {manage && <button className="small" onClick={() => setEditWf(w)}>Edit</button>}
                </div>
              </div>
              {w.description && <div>{w.description}</div>}
              <div className="flow">
                {w.inputs.length ? w.inputs.map((c) => <span className="tag" key={c}>{label(c)}</span>) : <span className="note">no tracked inputs</span>}
                <span className="arrow">→</span><b>{w.name}</b><span className="arrow">→</span>
                {w.outputs.map((c) => <span className="tag" key={c}>{label(c)}</span>)}
                {w.otherOutputs && <span className="note">{w.otherOutputs}</span>}
              </div>
              <div className="kvs">
                <span>Runs on <b>{w.host || "not set"}</b></span>
                {w.tool && <span>Tool <b>{w.tool}{w.version ? " " + w.version : ""}</b></span>}
                <span>Updated by {personName(d, state.me, w.updatedBy)}, {when(w.updatedAt)}</span>
              </div>
              {w.command && <pre className="cmd">{w.command}</pre>}
              {runs.length ? (
                <div className="scroll">
                  <table>
                    <thead><tr><th>Study</th><th>Status</th><th>Output location</th><th>Version</th><th>Recorded</th><th>Inputs since</th><th /></tr></thead>
                    <tbody>
                      {runs.map((r) => {
                        const c = runInputChanges(d, r);
                        const n = c.changed.length + c.removed + c.added.length;
                        return (
                          <tr key={r.id}>
                            <td>{studyLabel(d.studies.get(r.studyId))}</td>
                            <td><Chip status={r.status === "completed" ? "ready" : r.status === "failed" ? "failed" : "running"}>{r.status}</Chip></td>
                            <td className="mono">{r.outputPath ? where({ host: r.host, path: r.outputPath }) : "—"}</td>
                            <td>{r.version}</td>
                            <td className="note">{personName(d, state.me, r.createdBy)}, {when(r.createdAt)}</td>
                            <td>{n ? <Chip status="stale">{n} changed</Chip> : <span className="note">unchanged</span>}</td>
                            <td>{can(state.me, "runs.record", r.studyId) && <button className="small" onClick={() => setRunFor({ wf: w, run: r })}>Edit</button>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <div className="note">No runs recorded yet.</div>}
            </article>
          );
        })}
      </div>
      {editWf && <WorkflowPanel wf={editWf === "new" ? null : editWf} onClose={() => setEditWf(null)} />}
      {runFor && <RunPanel wf={runFor.wf} run={runFor.run} onClose={() => setRunFor(null)} />}
    </section>
  );
}

function WorkflowPanel({ wf, onClose }: { wf: Workflow | null; onClose: () => void }) {
  const { state, act } = useStore();
  const leaves = leafCategories(state!.categories);
  const [f, setF] = useState({
    name: wf?.name ?? "", description: wf?.description ?? "", host: wf?.host ?? "", tool: wf?.tool ?? "", version: wf?.version ?? "",
    command: wf?.command ?? "", otherOutputs: wf?.otherOutputs ?? "", sortOrder: wf?.sortOrder ?? state!.workflows.length + 1,
    inputs: wf?.inputs ?? [], outputs: wf?.outputs ?? [],
  });
  const toggle = (k: "inputs" | "outputs", id: number) =>
    setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] });
  const txt = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: k === "sortOrder" ? Number(e.target.value) : e.target.value });
  const save = async (archived = wf?.archived ?? false) => {
    const ok = await act(() => (wf ? put(`/workflows/${wf.id}`, { ...f, archived }) : post("/workflows", f)), "Workflow saved");
    if (ok) onClose();
  };
  const boxes = (k: "inputs" | "outputs") => (
    <div className="checks">
      {leaves.map((c) => <label className="ck" key={c.id}><input type="checkbox" checked={f[k].includes(c.id)} onChange={() => toggle(k, c.id)} />{c.label}</label>)}
    </div>
  );
  return (
    <Panel title={wf ? `Edit ${wf.name}` : "Add workflow"} onClose={onClose}>
      <Field label="Name">{(id) => <input id={id} value={f.name} onChange={txt("name")} />}</Field>
      <Field label="Description">{(id) => <textarea id={id} rows={2} value={f.description} onChange={txt("description")} />}</Field>
      <div className="field"><span className="label">Inputs</span>{boxes("inputs")}</div>
      <div className="field"><span className="label">Outputs</span>{boxes("outputs")}</div>
      <Field label="Other outputs" hint="Outputs not tracked as a data category">{(id) => <input id={id} value={f.otherOutputs} onChange={txt("otherOutputs")} />}</Field>
      <Field label="Runs on">{(id) => <input id={id} value={f.host} onChange={txt("host")} placeholder="beast2 (Slurm)" />}</Field>
      <div className="two">
        <Field label="Tool">{(id) => <input id={id} value={f.tool} onChange={txt("tool")} />}</Field>
        <Field label="Version">{(id) => <input id={id} value={f.version} onChange={txt("version")} />}</Field>
      </div>
      <Field label="Command">{(id) => <textarea id={id} className="mono" rows={3} value={f.command} onChange={txt("command")} />}</Field>
      <Field label="Sort order">{(id) => <input id={id} type="number" value={f.sortOrder} onChange={txt("sortOrder")} />}</Field>
      <div className="actions">
        <button className="primary" onClick={() => save()} disabled={!f.name}>{wf ? "Save workflow" : "Add workflow"}</button>
        {wf && <button className={wf.archived ? "" : "danger"} onClick={() => save(!wf.archived)}>{wf.archived ? "Restore" : "Archive"}</button>}
      </div>
      {wf && <section className="stack"><h3>History</h3><History query={`entity=workflow&entityId=${wf.id}`} /></section>}
    </Panel>
  );
}

function RunPanel({ wf, run, onClose }: { wf: Workflow; run: Run | null; onClose: () => void }) {
  const { state, d, act } = useStore();
  const studies = state!.studies.filter((s) => !s.archived && can(state!.me, "runs.record", s.id));
  const [f, setF] = useState({
    studyId: run?.studyId ?? studies[0]?.id ?? 0, status: run?.status ?? "completed", host: run?.host ?? wf.host,
    outputPath: run?.outputPath ?? "", version: run?.version ?? wf.version, notes: run?.notes ?? "",
  });
  const [outs, setOuts] = useState<Record<number, boolean>>(() => Object.fromEntries(wf.outputs.map((c) => [c, wf.outputs.length === 1])));
  const canWriteLoc = can(state!.me, "locations.edit", f.studyId);
  const txt = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: k === "studyId" ? Number(e.target.value) : e.target.value });
  const save = async () => {
    const ok = await act(() => run
      ? put(`/runs/${run.id}`, { status: f.status, host: f.host, outputPath: f.outputPath, version: f.version, notes: f.notes })
      : post("/runs", { ...f, workflowId: wf.id,
          createOutputs: canWriteLoc && f.outputPath ? wf.outputs.filter((c) => outs[c]).map((c) => ({ categoryId: c, kind: "directory" })) : [] }),
    run ? "Run saved" : "Run recorded");
    if (ok) onClose();
  };
  if (!studies.length && !run) return <Panel title={`Record ${wf.name} run`} onClose={onClose}><div className="note">No study is inside your study scope.</div></Panel>;
  const changes = run ? runInputChanges(d!, run) : null;
  return (
    <Panel title={run ? `${wf.name} run #${run.id}` : `Record ${wf.name} run`} onClose={onClose}>
      <div className="two">
        <Field label="Study">{(id) => (
          <select id={id} value={f.studyId} onChange={txt("studyId")} disabled={!!run}>
            {(run ? state!.studies.filter((s) => s.id === run.studyId) : studies).map((s) => <option key={s.id} value={s.id}>{studyLabel(s)}</option>)}
          </select>)}
        </Field>
        <Field label="Status">{(id) => (
          <select id={id} value={f.status} onChange={txt("status")}>
            <option value="completed">completed</option><option value="running">running</option><option value="failed">failed</option>
          </select>)}
        </Field>
      </div>
      <Field label="Host">{(id) => <input id={id} value={f.host} onChange={txt("host")} />}</Field>
      <Field label="Output location">{(id) => <textarea id={id} className="mono" rows={2} value={f.outputPath} onChange={txt("outputPath")} placeholder="/space/ceph/1/…" />}</Field>
      <div className="two">
        <Field label="Version">{(id) => <input id={id} value={f.version} onChange={txt("version")} />}</Field>
        <div />
      </div>
      <Field label="Notes">{(id) => <textarea id={id} rows={2} value={f.notes} onChange={txt("notes")} />}</Field>

      <section className="stack">
        <h3>{run ? "Inputs when recorded" : "Inputs (their current state is saved with the run)"}</h3>
        {!wf.inputs.length && <div className="note">None tracked.</div>}
        {wf.inputs.map((c) => {
          const locs = run ? run.inputs.locations.filter((l) => l.categoryId === c) : d!.locationsByCell.get(cellKey(f.studyId, c)) ?? [];
          return (
            <div key={c} className="dep">
              <div className="flow"><Chip status={cellStatus(d!, f.studyId, c)} /><b>{d!.categories.get(c)?.label}</b></div>
              {locs.length ? locs.map((l) => <div key={"locationId" in l ? l.locationId : l.id} className="mono note">{where(l)}</div>)
                : <div className="note">no locations recorded</div>}
            </div>
          );
        })}
        {changes && (changes.changed.length + changes.removed + changes.added.length > 0) && (
          <div className="banner warn">Since this run: {changes.changed.length} input location(s) edited, {changes.removed} removed, {changes.added.length} added.</div>
        )}
      </section>

      {!run && wf.outputs.length > 0 && (
        <section className="stack">
          <h3>Outputs</h3>
          {!canWriteLoc && <div className="note">Your role can't add data paths for this study, so the output location is kept only on the run.</div>}
          {canWriteLoc && wf.outputs.map((c) => (
            <label className="ck" key={c}>
              <input type="checkbox" checked={!!outs[c]} onChange={(e) => setOuts({ ...outs, [c]: e.target.checked })} />
              Add the output location as a {d!.categories.get(c)?.label} path for {studyLabel(d!.studies.get(f.studyId))}
            </label>
          ))}
        </section>
      )}
      <div className="actions"><button className="primary" onClick={save} disabled={!f.studyId}>{run ? "Save run" : "Record run"}</button></div>
      {run && <section className="stack"><h3>History</h3><History query={`entity=run&entityId=${run.id}`} /></section>}
    </Panel>
  );
}
