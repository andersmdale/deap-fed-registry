import { useState, type FormEvent } from "react";
import { post } from "../api";
import { Field } from "../components/ui";
import type { Me } from "../types";

function Frame({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <div className="center-page">
      <div className="auth-card">
        <div className="eyebrow">DEAP-Fed Data Registry</div>
        <h1>{title}</h1>
        {intro && <p className="note">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { onDone((await post<{ user: Me }>("/auth/login", { username, password })).user); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <Frame title="Sign in">
      <form onSubmit={submit} className="stack">
        <Field label="Username">{(id) => <input id={id} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />}</Field>
        <Field label="Password">{(id) => <input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        {err && <div className="banner bad">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="note">Forgot your password? Ask an admin to set a temporary one.</p>
      </form>
    </Frame>
  );
}

export function Setup({ onDone, tokenFile }: { onDone: (me: Me) => void; tokenFile: string }) {
  const [f, setF] = useState({ token: "", username: "", displayName: "", email: "", password: "", again: "" });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr("");
    if (f.password !== f.again) return setErr("The two passwords don't match");
    try { onDone((await post<{ user: Me }>("/auth/setup", f)).user); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <Frame title="Create the first admin" intro={`No accounts exist yet. On the server, run: cat ${tokenFile} and paste the token below. It stops working once this account exists.`}>
      <form onSubmit={submit} className="stack">
        <Field label="Setup token">{(id) => <input id={id} className="mono" value={f.token} onChange={set("token")} required />}</Field>
        <div className="two">
          <Field label="Username">{(id) => <input id={id} autoComplete="username" value={f.username} onChange={set("username")} required />}</Field>
          <Field label="Display name">{(id) => <input id={id} value={f.displayName} onChange={set("displayName")} />}</Field>
        </div>
        <Field label="Email">{(id) => <input id={id} type="email" value={f.email} onChange={set("email")} />}</Field>
        <div className="two">
          <Field label="Password" hint="At least 10 characters">{(id) => <input id={id} type="password" autoComplete="new-password" value={f.password} onChange={set("password")} required />}</Field>
          <Field label="Repeat password">{(id) => <input id={id} type="password" autoComplete="new-password" value={f.again} onChange={set("again")} required />}</Field>
        </div>
        {err && <div className="banner bad">{err}</div>}
        <button className="primary">Create admin and sign in</button>
      </form>
    </Frame>
  );
}

export function PasswordForm({ onDone, submitLabel = "Change password" }: { onDone: (me: Me) => void; submitLabel?: string }) {
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr("");
    if (f.next !== f.again) return setErr("The two new passwords don't match");
    try { onDone((await post<{ user: Me }>("/auth/password", { current: f.current, next: f.next })).user); setF({ current: "", next: "", again: "" }); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <form onSubmit={submit} className="stack">
      <Field label="Current password">{(id) => <input id={id} type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />}</Field>
      <div className="two">
        <Field label="New password" hint="At least 10 characters">{(id) => <input id={id} type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />}</Field>
        <Field label="Repeat new password">{(id) => <input id={id} type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required />}</Field>
      </div>
      {err && <div className="banner bad">{err}</div>}
      <button className="primary">{submitLabel}</button>
    </form>
  );
}

export function PasswordChange({ me, onDone, onSignOut }: { forced?: boolean; me: Me; onDone: (me: Me) => void; onSignOut: () => void }) {
  return (
    <Frame title="Choose a new password" intro={`${me.displayName}, your account has a temporary password. Choose your own before continuing.`}>
      <PasswordForm onDone={onDone} submitLabel="Save and continue" />
      <button className="link" style={{ marginTop: 12 }} onClick={async () => { await post("/auth/logout").catch(() => undefined); onSignOut(); }}>Sign out</button>
    </Frame>
  );
}
