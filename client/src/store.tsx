import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, get } from "./api";
import { derive, type Derived } from "./model";
import type { RegistryState } from "./types";

interface Store {
  state: RegistryState | null;
  d: Derived | null;
  error: string;
  refresh: () => Promise<void>;
  toast: (msg: string) => void;
  /** Run a change, report errors as a toast, refresh the registry on success. Resolves true when it worked. */
  act: <T>(fn: () => Promise<T>, done?: string) => Promise<T | null>;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
};

const POLL_MS = 30_000;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RegistryState | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const timer = useRef<number>();

  const refresh = useCallback(async () => {
    try {
      setState(await get<RegistryState>("/state"));
      setError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setError(e.message);
      else if (e instanceof ApiError && e.status >= 500) setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const tick = () => { if (document.visibilityState === "visible") refresh(); };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [refresh]);

  const toast = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(""), 4000);
  }, []);

  const act = useCallback(async <T,>(fn: () => Promise<T>, done?: string): Promise<T | null> => {
    try {
      const out = await fn();
      if (done) toast(done);
      await refresh();
      return out;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [refresh, toast]);

  const d = useMemo(() => (state ? derive(state) : null), [state]);
  const value = useMemo(() => ({ state, d, error, refresh, toast, act }), [state, d, error, refresh, toast, act]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </Ctx.Provider>
  );
}
