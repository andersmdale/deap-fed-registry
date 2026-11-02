import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, get, onAuthProblem, post } from "./api";
import { can } from "./model";
import { StoreProvider, useStore } from "./store";
import type { Me } from "./types";
import { Login, PasswordChange, Setup } from "./pages/Auth";
import { DataPage } from "./pages/Data";
import { StudiesPage } from "./pages/Studies";
import { CategoriesPage } from "./pages/Categories";
import { WorkflowsPage } from "./pages/Workflows";
import { ActivityPage } from "./pages/Activity";
import { PeoplePage } from "./pages/People";
import { AccountPage } from "./pages/Account";

type Session = { kind: "loading" } | { kind: "setup"; tokenFile: string } | { kind: "signed-out" } | { kind: "error"; message: string } | { kind: "in"; me: Me };

export default function App() {
  const [session, setSession] = useState<Session>({ kind: "loading" });

  const check = useCallback(async () => {
    try {
      const { user } = await get<{ user: Me }>("/auth/me");
      setSession({ kind: "in", me: user });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          const s = await get<{ needed: boolean; tokenFile?: string }>("/auth/setup");
          setSession(s.needed ? { kind: "setup", tokenFile: s.tokenFile ?? "setup-token.txt" } : { kind: "signed-out" });
        } catch (e2) {
          setSession({ kind: "error", message: (e2 as Error).message });
        }
      } else setSession({ kind: "error", message: (e as Error).message });
    }
  }, []);

  useEffect(() => { check(); return onAuthProblem(() => check()); }, [check]);

  const signedIn = (me: Me) => setSession({ kind: "in", me });

  switch (session.kind) {
    case "loading": return <div className="center-page"><p className="note">Loading…</p></div>;
    case "error": return <div className="center-page"><div className="banner bad">{session.message}</div><button onClick={check}>Try again</button></div>;
    case "setup": return <Setup onDone={signedIn} tokenFile={session.tokenFile} />;
    case "signed-out": return <Login onDone={signedIn} />;
    case "in":
      if (session.me.mustChangePassword) return <PasswordChange forced me={session.me} onDone={signedIn} onSignOut={check} />;
      return (
        <StoreProvider>
          <Shell onSignOut={async () => { await post("/auth/logout").catch(() => undefined); check(); }} />
        </StoreProvider>
      );
  }
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const { state, error } = useStore();
  const me = state?.me ?? null;
  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>DEAP-Fed Data Registry</h1>
          <p className="sub">Where each study's data lives, who signed it off as Ready, and which workflow produced it.</p>
        </div>
        {me && (
          <div className="me">
            <span>Signed in as <b>{me.displayName}</b></span>
            <span className="tag">{me.roleName}{me.studyScope !== "*" ? ` · ${me.studyScope.length} studies` : ""}</span>
            <button className="small" onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </header>
      <nav className="tabs" aria-label="Sections">
        <NavLink to="/" end>Data</NavLink>
        <NavLink to="/studies">Studies</NavLink>
        <NavLink to="/categories">Categories</NavLink>
        <NavLink to="/workflows">Workflows</NavLink>
        <NavLink to="/activity">Activity</NavLink>
        {can(me, "users.manage") && <NavLink to="/people">People &amp; roles</NavLink>}
        <NavLink to="/account">Account</NavLink>
      </nav>
      {error && <div className="banner bad">{error}</div>}
      {!state ? <p className="note">Loading the registry…</p> : (
        <Routes>
          <Route path="/" element={<DataPage />} />
          <Route path="/studies" element={<StudiesPage />} />
          <Route path="/categories" element={<CategoriesPage />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/people" element={can(me, "users.manage") ? <PeoplePage /> : <Navigate to="/" />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      )}
    </div>
  );
}
