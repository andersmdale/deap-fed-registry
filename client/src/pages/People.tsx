import { useEffect, useState } from "react";
import { del, get, post, put } from "../api";
import { ConfirmButton, CopyButton, Field, History, Panel } from "../components/ui";
import { studyLabel, when } from "../model";
import { useStore } from "../store";
import type { Privilege, Role, StudyScope, UserRecord } from "../types";

export function PeoplePage() {
  const { state, act } = useStore();
  const [tab, setTab] = useState<"users" | "roles">("users");
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [open, setOpen] = useState<UserRecord | "new" | null>(null);
  const [role, setRole] = useState<Role | "new" | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => { get<UserRecord[]>("/admin/users").then(setUsers).catch(() => undefined); }, [rev, state]);
  if (!state) return null;
  const roleName = (id: number) => state.roles.find((r) => r.id === id)?.name ?? "?";
  const scopeText = (s: StudyScope) => (s === "*" ? "All studies" : s.length ? s.map((id) => state.studies.find((x) => x.id === id)?.code ?? "?").join(", ") : "No studies");
  const reload = () => setRev((r) => r + 1);
  return (
    <section>
      <div className="subtabs">
        <button className={tab === "users" ? "on" : ""} onClick={() => setTab("users")}>Users ({users.filter((u) => u.active).length})</button>
        <button className={tab === "roles" ? "on" : ""} onClick={() => setTab("roles")}>Roles and privileges</button>
      </div>
      {tab === "users" ? (
        <>
          <div className="bar">
            <p className="note grow">Everyone with an account. A user's role sets their privileges; their study scope limits the privileges marked “per study” to the studies chosen.</p>
            <button className="primary" onClick={() => setOpen("new")}>Add user</button>
          </div>
          <div className="scroll">
            <table>
              <thead><tr><th>Person</th><th>Username</th><th>Role</th><th>Studies</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.active ? "" : "archived"}>
                    <td><b>{u.displayName || u.username}</b>{u.email && <div className="note">{u.email}</div>}</td>
                    <td className="mono">{u.username}</td>
                    <td>{roleName(u.roleId)}</td>
                    <td>{scopeText(u.studyScope)}</td>
                    <td className="note">{u.lastLoginAt ? when(u.lastLoginAt) : "never"}</td>
                    <td>{!u.active ? "Deactivated" : u.mustChangePassword ? "Temporary password" : "Active"}</td>
                    <td><button className="small" onClick={() => setOpen(u)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="bar">
            <p className="note grow">Roles bundle privileges. Built-in roles can be changed but not deleted.</p>
            <button className="primary" onClick={() => setRole("new")}>Add role</button>
          </div>
          <div className="scroll">
            <table>
              <thead><tr><th>Role</th>{state.privileges.map((p) => <th key={p.id} className="priv-col">{p.label}{p.scoped && <span className="cnt">per study</span>}</th>)}<th>Users</th><th /></tr></thead>
              <tbody>
                {state.roles.map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.name}</b>{r.description && <div className="note">{r.description}</div>}</td>
                    {state.privileges.map((p) => <td key={p.id} className="center">{r.privileges.includes(p.id) ? "●" : <span className="note">–</span>}</td>)}
                    <td className="num">{r.users}</td>
                    <td><button className="small" onClick={() => setRole(r)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {open && <UserPanel user={open === "new" ? null : open} onClose={() => { setOpen(null); reload(); }} />}
      {role && <RolePanel role={role === "new" ? null : role} onClose={() => setRole(null)} onDelete={async (r) => {
        if (await act(() => del(`/admin/roles/${r.id}`), "Role deleted")) setRole(null);
      }} />}
    </section>
  );
}

function ScopePicker({ value, onChange }: { value: StudyScope; onChange: (s: StudyScope) => void }) {
  const { state } = useStore();
  const all = value === "*";
  const list = all ? [] : value;
  return (
    <div className="stack tight">
      <label className="ck"><input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? "*" : [])} /> All studies, including ones added later</label>
      {!all && (
        <div className="checks">
          {state!.studies.filter((s) => !s.archived).map((s) => (
            <label className="ck" key={s.id}>
              <input type="checkbox" checked={list.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...list, s.id] : list.filter((x) => x !== s.id))} />
              {studyLabel(s)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function UserPanel({ user, onClose }: { user: UserRecord | null; onClose: () => void }) {
  const { state, act } = useStore();
  const viewer = state!.roles.find((r) => r.name === "Viewer") ?? state!.roles[0];
  const [f, setF] = useState({
    username: user?.username ?? "", displayName: user?.displayName ?? "", email: user?.email ?? "",
    roleId: user?.roleId ?? viewer.id, studyScope: (user?.studyScope ?? "*") as StudyScope, active: user?.active ?? true,
  });
  const [temp, setTemp] = useState("");
  const self = user?.id === state!.me.id;
  const role = state!.roles.find((r) => r.id === f.roleId);
  const save = async () => {
    if (user) {
      const ok = await act(() => put(`/admin/users/${user.id}`, { displayName: f.displayName, email: f.email, roleId: f.roleId, studyScope: f.studyScope, active: f.active }), "User saved");
      if (ok) onClose();
    } else {
      const out = await act(() => post<{ temporaryPassword: string }>("/admin/users", f), "User added");
      if (out) setTemp(out.temporaryPassword);
    }
  };
  const reset = async () => {
    const out = await act(() => post<{ temporaryPassword: string }>(`/admin/users/${user!.id}/password`, {}), "Temporary password set");
    if (out) setTemp(out.temporaryPassword);
  };
  if (temp) {
    return (
      <Panel title={user ? `Temporary password for ${user.username}` : `${f.username} added`} onClose={onClose}>
        <p>Give {f.displayName || f.username} this temporary password. They choose their own when they first sign in. It isn't shown again.</p>
        <div className="flow"><span className="mono big">{temp}</span><CopyButton text={temp} /></div>
        <div className="actions"><button className="primary" onClick={onClose}>Done</button></div>
      </Panel>
    );
  }
  return (
    <Panel title={user ? `Edit ${user.displayName || user.username}` : "Add user"} onClose={onClose}>
      <div className="two">
        <Field label="Username" hint={user ? "Usernames can't be changed" : "Letters, digits, . _ @ -"}>{(id) =>
          <input id={id} className="mono" value={f.username} disabled={!!user} onChange={(e) => setF({ ...f, username: e.target.value })} />}</Field>
        <Field label="Display name">{(id) => <input id={id} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />}</Field>
      </div>
      <Field label="Email">{(id) => <input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
      <Field label="Role" hint={role ? role.description : undefined}>{(id) => (
        <select id={id} value={f.roleId} onChange={(e) => setF({ ...f, roleId: Number(e.target.value) })}>
          {state!.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>)}
      </Field>
      {role && (
        <div className="note">Privileges: {role.privileges.length ? role.privileges.map((p) => state!.privileges.find((x) => x.id === p)?.label).join(", ") : "none (read-only)"}</div>
      )}
      <div className="field"><span className="label">Study scope</span><ScopePicker value={f.studyScope} onChange={(s) => setF({ ...f, studyScope: s })} /></div>
      {user && <label className="ck"><input type="checkbox" checked={f.active} disabled={self} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Account active{self ? " (you can't deactivate yourself)" : ""}</label>}
      {!user && <div className="note">A temporary password is generated; you'll see it once, after adding.</div>}
      <div className="actions">
        <button className="primary" onClick={save} disabled={!f.username}>{user ? "Save changes" : "Add user"}</button>
        {user && <ConfirmButton label="Set temporary password" confirm={`Sign ${user.username} out and set a temporary password?`} onConfirm={reset} />}
      </div>
      {user && <section className="stack"><h3>History</h3><History query={`entity=user&entityId=${user.id}`} /></section>}
    </Panel>
  );
}

function RolePanel({ role, onClose, onDelete }: { role: Role | null; onClose: () => void; onDelete: (r: Role) => void }) {
  const { state, act } = useStore();
  const [f, setF] = useState({ name: role?.name ?? "", description: role?.description ?? "", privileges: role?.privileges ?? ([] as Privilege[]) });
  const toggle = (p: Privilege) => setF({ ...f, privileges: f.privileges.includes(p) ? f.privileges.filter((x) => x !== p) : [...f.privileges, p] });
  const save = async () => {
    const ok = await act(() => (role ? put(`/admin/roles/${role.id}`, f) : post("/admin/roles", f)), "Role saved");
    if (ok) onClose();
  };
  return (
    <Panel title={role ? `Edit role ${role.name}` : "Add role"} onClose={onClose}>
      <Field label="Name">{(id) => <input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <Field label="Description">{(id) => <textarea id={id} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      <div className="field">
        <span className="label">Privileges</span>
        <div className="stack tight">
          {state!.privileges.map((p) => (
            <label className="ck" key={p.id}><input type="checkbox" checked={f.privileges.includes(p.id)} onChange={() => toggle(p.id)} />
              {p.label}{p.scoped && <span className="note"> · limited to the user's study scope</span>}</label>
          ))}
        </div>
      </div>
      <div className="note">Every signed-in user can read the whole registry; privileges control changes.</div>
      <div className="actions">
        <button className="primary" onClick={save} disabled={!f.name}>{role ? "Save role" : "Add role"}</button>
        {role && !role.builtin && <ConfirmButton className="danger" label="Delete role" confirm={`Delete the ${role.name} role?`} onConfirm={() => onDelete(role)} />}
      </div>
      {role && <section className="stack"><h3>History</h3><History query={`entity=role&entityId=${role.id}`} /></section>}
    </Panel>
  );
}
