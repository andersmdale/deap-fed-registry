import { useState } from "react";
import { post, put } from "../api";
import { Empty, Field, History, Panel } from "../components/ui";
import { can, cellStatus, leafCategories, personName, studyLabel, when } from "../model";
import { useStore } from "../store";
import type { Study } from "../types";

export function StudiesPage() {
  const { state, d } = useStore();
  const [open, setOpen] = useState<Study | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  if (!state || !d) return null;
  const manage = can(state.me, "studies.manage");
  const leaves = leafCategories(state.categories);
  const list = state.studies.filter((s) => showArchived || !s.archived);
  return (
    <section>
      <div className="bar">
        <p className="note grow">The studies whose data the registry tracks. Each row counts its data categories by status.</p>
        <label className="ck"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {manage && <button className="primary" onClick={() => setOpen("new")}>Add study</button>}
      </div>
      {!list.length ? <Empty>No studies yet.</Empty> : (
        <div className="scroll">
          <table>
            <thead><tr><th>Study</th><th>Code</th><th>TRE</th><th>Access</th><th>Default host</th><th>Ready</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {list.map((s) => {
                const sts = leaves.map((c) => cellStatus(d, s.id, c.id)).filter((x) => x !== "na");
                return (
                  <tr key={s.id} className={s.archived ? "archived" : ""}>
                    <td><b>{studyLabel(s)}</b>{s.description && <div className="note clamp">{s.description}</div>}</td>
                    <td className="mono">{s.code}</td>
                    <td>{s.tre}</td>
                    <td>{s.access === "sumstats" ? "Summary statistics" : s.access === "tre" ? "TRE" : "Other"}</td>
                    <td>{s.defaultHost}</td>
                    <td className="num">{sts.filter((x) => x === "ready").length} of {sts.length}</td>
                    <td className="note">{personName(d, state.me, s.updatedBy)}, {when(s.updatedAt)}</td>
                    <td>{manage && <button className="small" onClick={() => setOpen(s)}>Edit</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <StudyPanel study={open === "new" ? null : open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function StudyPanel({ study, onClose }: { study: Study | null; onClose: () => void }) {
  const { state, act } = useStore();
  const [f, setF] = useState({
    code: study?.code ?? "", name: study?.name ?? "", release: study?.release ?? "", tre: study?.tre ?? "", access: study?.access ?? "tre",
    defaultHost: study?.defaultHost ?? "", description: study?.description ?? "", sortOrder: study?.sortOrder ?? (state!.studies.length + 1),
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: k === "sortOrder" ? Number(e.target.value) : e.target.value });
  const save = async (archived = study?.archived ?? false) => {
    const ok = await act(() => (study ? put(`/studies/${study.id}`, { ...f, archived }) : post("/studies", f)), study ? "Study saved" : "Study added");
    if (ok) onClose();
  };
  return (
    <Panel title={study ? `Edit ${studyLabel(study)}` : "Add study"} onClose={onClose}>
      <div className="two">
        <Field label="Name">{(id) => <input id={id} value={f.name} onChange={set("name")} placeholder="ABCD" />}</Field>
        <Field label="Code" hint="Short unique id, e.g. ABCD or HCP-YA">{(id) => <input id={id} className="mono" value={f.code} onChange={set("code")} />}</Field>
      </div>
      <div className="two">
        <Field label="Release">{(id) => <input id={id} value={f.release} onChange={set("release")} placeholder="optional" />}</Field>
        <Field label="DEAP-Fed TRE">{(id) => <input id={id} value={f.tre} onChange={set("tre")} placeholder="tre-nbdc" />}</Field>
      </div>
      <div className="two">
        <Field label="Data access">{(id) => (
          <select id={id} value={f.access} onChange={set("access")}>
            <option value="tre">TRE</option><option value="sumstats">Summary statistics only</option><option value="other">Other</option>
          </select>)}
        </Field>
        <Field label="Sort order">{(id) => <input id={id} type="number" value={f.sortOrder} onChange={set("sortOrder")} />}</Field>
      </div>
      <Field label="Default host" hint="Pre-filled when someone adds a path for this study">{(id) => <input id={id} value={f.defaultHost} onChange={set("defaultHost")} />}</Field>
      <Field label="Description">{(id) => <textarea id={id} rows={3} value={f.description} onChange={set("description")} />}</Field>
      <div className="actions">
        <button className="primary" onClick={() => save()} disabled={!f.name || !f.code}>{study ? "Save changes" : "Add study"}</button>
        {study && <button className={study.archived ? "" : "danger"} onClick={() => save(!study.archived)}>{study.archived ? "Restore study" : "Archive study"}</button>}
      </div>
      {study && <section className="stack"><h3>History</h3><History query={`entity=study&entityId=${study.id}`} /></section>}
    </Panel>
  );
}
