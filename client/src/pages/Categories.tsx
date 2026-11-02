import { useState } from "react";
import { post, put } from "../api";
import { Field, History, Panel } from "../components/ui";
import { can, categoryTree } from "../model";
import { useStore } from "../store";
import type { Category } from "../types";

export function CategoriesPage() {
  const { state } = useStore();
  const [open, setOpen] = useState<{ cat: Category | null; parentId: number | null } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  if (!state) return null;
  const manage = can(state.me, "categories.manage");
  const tree = categoryTree(state.categories, showArchived);
  const wfUse = (id: number) => state.workflows.filter((w) => !w.archived && (w.inputs.includes(id) || w.outputs.includes(id))).map((w) => w.name);
  return (
    <section>
      <div className="bar">
        <p className="note grow">Categories of data recorded for each study, in two levels: a group (such as Raw data) and the categories under it. They are the columns of the data grid.</p>
        <label className="ck"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {manage && <button className="primary" onClick={() => setOpen({ cat: null, parentId: null })}>Add group</button>}
      </div>
      <div className="cards">
        {tree.map(({ group }) => {
          const kids = state.categories.filter((c) => c.parentId === group.id && (showArchived || !c.archived)).sort((a, b) => a.sortOrder - b.sortOrder);
          return (
            <article className={`card ${group.archived ? "archived" : ""}`} key={group.id}>
              <div className="row-between">
                <div><h3>{group.label}</h3>{group.description && <div className="note">{group.description}</div>}</div>
                {manage && <div className="actions">
                  <button className="small" onClick={() => setOpen({ cat: null, parentId: group.id })}>Add category</button>
                  <button className="small" onClick={() => setOpen({ cat: group, parentId: null })}>Edit group</button>
                </div>}
              </div>
              {kids.length ? (
                <div className="scroll">
                  <table>
                    <thead><tr><th>Category</th><th>Code</th><th>Used by workflows</th><th /></tr></thead>
                    <tbody>
                      {kids.map((c) => (
                        <tr key={c.id} className={c.archived ? "archived" : ""}>
                          <td><b>{c.label}</b>{c.description && <div className="note">{c.description}</div>}</td>
                          <td className="mono">{c.code}</td>
                          <td className="note">{wfUse(c.id).join(", ") || "—"}</td>
                          <td>{manage && <button className="small" onClick={() => setOpen({ cat: c, parentId: c.parentId })}>Edit</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="note">No categories in this group; the group itself is a column.</div>}
            </article>
          );
        })}
      </div>
      {open && <CategoryPanel cat={open.cat} parentId={open.parentId} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CategoryPanel({ cat, parentId, onClose }: { cat: Category | null; parentId: number | null; onClose: () => void }) {
  const { state, act } = useStore();
  const groups = state!.categories.filter((c) => c.parentId == null && c.id !== cat?.id);
  const hasKids = !!cat && state!.categories.some((c) => c.parentId === cat.id);
  const [f, setF] = useState({
    parentId: cat ? cat.parentId : parentId, code: cat?.code ?? "", label: cat?.label ?? "", description: cat?.description ?? "",
    sortOrder: cat?.sortOrder ?? 99,
  });
  const save = async (archived = cat?.archived ?? false) => {
    const ok = await act(() => (cat ? put(`/categories/${cat.id}`, { ...f, archived }) : post("/categories", f)), "Saved");
    if (ok) onClose();
  };
  const isGroup = f.parentId == null;
  return (
    <Panel title={cat ? `Edit ${cat.label}` : isGroup ? "Add group" : "Add category"} onClose={onClose}>
      <div className="two">
        <Field label="Label">{(id) => <input id={id} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={isGroup ? "Raw data" : "PET scans"} />}</Field>
        <Field label="Code" hint="Short unique id">{(id) => <input id={id} className="mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder={isGroup ? "raw" : "pet"} />}</Field>
      </div>
      <div className="two">
        <Field label="Group">{(id) => (
          <select id={id} value={f.parentId ?? ""} disabled={hasKids} onChange={(e) => setF({ ...f, parentId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None: this is a top-level group</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>)}
        </Field>
        <Field label="Sort order">{(id) => <input id={id} type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />}</Field>
      </div>
      <Field label="Description">{(id) => <textarea id={id} rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      <div className="actions">
        <button className="primary" onClick={() => save()} disabled={!f.label || !f.code}>{cat ? "Save changes" : "Add"}</button>
        {cat && <button className={cat.archived ? "" : "danger"} onClick={() => save(!cat.archived)}>{cat.archived ? "Restore" : "Archive"}</button>}
      </div>
      {cat && <div className="note">Archiving hides the column; recorded paths are kept and come back if you restore it.</div>}
      {cat && <section className="stack"><h3>History</h3><History query={`entity=category&entityId=${cat.id}`} /></section>}
    </Panel>
  );
}
