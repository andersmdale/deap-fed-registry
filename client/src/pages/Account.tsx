import { History } from "../components/ui";
import { useStore } from "../store";
import { PasswordForm } from "./Auth";

export function AccountPage() {
  const { state, toast, refresh } = useStore();
  if (!state) return null;
  const me = state.me;
  const scope = me.studyScope === "*" ? "All studies" : me.studyScope.map((id) => state.studies.find((s) => s.id === id)?.name ?? "?").join(", ") || "No studies";
  return (
    <section className="account">
      <article className="card">
        <h3>{me.displayName}</h3>
        <div className="kvs">
          <span>Username <b className="mono">{me.username}</b></span>
          {me.email && <span>Email <b>{me.email}</b></span>}
          <span>Role <b>{me.roleName}</b></span>
          <span>Studies <b>{scope}</b></span>
        </div>
        <div>
          <div className="label">Your privileges</div>
          {me.privileges.length ? (
            <ul className="plain">
              {state.privileges.filter((p) => me.privileges.includes(p.id)).map((p) => <li key={p.id}>{p.label}{p.scoped ? " (your studies)" : ""}</li>)}
            </ul>
          ) : <div className="note">Read-only: you can see everything but change nothing.</div>}
        </div>
      </article>
      <article className="card">
        <h3>Change password</h3>
        <PasswordForm onDone={() => { toast("Password changed"); refresh(); }} />
      </article>
      <article className="card">
        <h3>Your recent changes</h3>
        <History query={`userId=${me.id}`} empty="You haven't changed anything yet." />
      </article>
    </section>
  );
}
