import { useState } from "react";
import { History } from "../components/ui";
import { studyLabel } from "../model";
import { useStore } from "../store";

const ENTITIES: [string, string][] = [
  ["", "All changes"], ["location", "Data paths"], ["cell", "N/A markings"], ["run", "Workflow runs"], ["workflow", "Workflows"],
  ["study", "Studies"], ["category", "Categories"], ["user", "Users"], ["role", "Roles"],
];

export function ActivityPage() {
  const { state } = useStore();
  const [studyId, setStudyId] = useState("");
  const [userId, setUserId] = useState("");
  const [entity, setEntity] = useState("");
  if (!state) return null;
  const q = new URLSearchParams();
  if (studyId) q.set("studyId", studyId);
  if (userId) q.set("userId", userId);
  if (entity) q.set("entity", entity);
  return (
    <section>
      <div className="bar">
        <select aria-label="Study" value={studyId} onChange={(e) => setStudyId(e.target.value)}>
          <option value="">All studies</option>
          {state.studies.map((s) => <option key={s.id} value={s.id}>{studyLabel(s)}</option>)}
        </select>
        <select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Everyone</option>
          {state.people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <select aria-label="Kind of change" value={entity} onChange={(e) => setEntity(e.target.value)}>
          {ENTITIES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
        <span className="note grow">Every change, with who made it and when.</span>
      </div>
      <History query={q.toString() || "all=1"} refreshKey={state} empty="No changes match these filters." />
    </section>
  );
}
