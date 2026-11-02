import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { get } from "../api";
import { STATUS_LABEL, personName, when, fullDate, type CellStatus } from "../model";
import { useStore } from "../store";
import type { AuditEntry } from "../types";

export function Chip({ status, children }: { status: CellStatus | "failed" | "running"; children?: ReactNode }) {
  const label = children ?? (status in STATUS_LABEL ? STATUS_LABEL[status as CellStatus] : status);
  return <span className={`chip s-${status}`}>{label}</span>;
}

export function Panel({ title, subtitle, onClose, children }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.close)")?.focus();
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="panel" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="note">{subtitle}</div>}
          </div>
          <button className="close" onClick={onClose}>Close</button>
        </header>
        <div className="panel-body">{children}</div>
      </div>
    </>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** An inline "are you sure" step: the first click shows the confirmation, the second does it. */
export function ConfirmButton({ label, confirm, onConfirm, className = "", disabled }: {
  label: string; confirm: ReactNode; onConfirm: () => void | Promise<unknown>; className?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) return <button className={className} disabled={disabled} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className={`confirm ${className.includes("danger") ? "confirm-danger" : ""}`}>
      <div>{confirm}</div>
      <div className="actions">
        <button className={className} onClick={async () => { await onConfirm(); setOpen(false); }}>Confirm</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const { toast } = useStore();
  return (
    <button className="small" onClick={() => navigator.clipboard.writeText(text).then(() => toast("Path copied"), () => toast("Copy isn't allowed here; select the path instead"))}>
      Copy
    </button>
  );
}

/** Audit entries for a filter, newest first, with "Show older". */
export function History({ query, refreshKey, empty = "No changes recorded." }: { query: string; refreshKey?: unknown; empty?: string }) {
  const { state, d } = useStore();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    get<{ entries: AuditEntry[]; more: boolean }>(`/audit?${query}&limit=50`)
      .then((r) => { if (live) { setEntries(r.entries); setMore(r.more); setErr(""); } })
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [query, refreshKey]);
  const older = async () => {
    const last = entries[entries.length - 1];
    const r = await get<{ entries: AuditEntry[]; more: boolean }>(`/audit?${query}&limit=100&before=${last.id}`);
    setEntries((e) => [...e, ...r.entries]); setMore(r.more);
  };
  if (err) return <div className="banner bad">{err}</div>;
  if (!entries.length) return <div className="note">{empty}</div>;
  return (
    <div className="log">
      {entries.map((e) => (
        <div className="log-row" key={e.id}>
          <div className="when" title={fullDate(e.ts)}>{when(e.ts)}</div>
          <div className="what">
            <b>{d ? personName(d, state?.me ?? null, e.userId) : ""}</b>{" "}
            <span>{e.summary}</span>
            {(e.studyId || e.categoryId) && d && (
              <div className="ctx">
                {[e.studyId ? d.studies.get(e.studyId)?.name : null, e.categoryId ? d.categories.get(e.categoryId)?.label : null].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
      ))}
      {more && <div className="log-row"><button className="link" onClick={older}>Show older</button></div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
