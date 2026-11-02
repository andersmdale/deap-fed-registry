/** Every privilege the registry checks. `scoped` privileges are limited to the studies in a user's study scope. */
export const PRIVILEGES = [
  { id: "users.manage", label: "Manage users and roles", scoped: false },
  { id: "studies.manage", label: "Manage studies", scoped: false },
  { id: "categories.manage", label: "Manage data categories", scoped: false },
  { id: "locations.edit", label: "Add and edit data paths", scoped: true },
  { id: "locations.ready", label: "Mark data Ready", scoped: true },
  { id: "workflows.manage", label: "Define workflows", scoped: false },
  { id: "runs.record", label: "Record workflow runs", scoped: true },
] as const;

export type Privilege = (typeof PRIVILEGES)[number]["id"];
export const PRIVILEGE_IDS = PRIVILEGES.map((p) => p.id) as Privilege[];

export const ROLE_PRESETS: Record<string, { name: string; description: string; privileges: Privilege[] }> = {
  admin: { name: "Admin", description: "Everything, including users, roles, studies and categories.", privileges: [...PRIVILEGE_IDS] },
  curator: { name: "Curator", description: "Records and signs off data, defines workflows and records runs.",
    privileges: ["locations.edit", "locations.ready", "workflows.manage", "runs.record"] },
  processor: { name: "Processor", description: "Records data paths and workflow runs; cannot sign off data as Ready.",
    privileges: ["locations.edit", "runs.record"] },
  viewer: { name: "Viewer", description: "Reads everything; changes nothing.", privileges: [] },
};

export type StudyScope = "*" | number[];

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  roleId: number;
  roleName: string;
  privileges: Privilege[];
  studyScope: StudyScope;
  mustChangePassword: boolean;
}

export function isScoped(p: Privilege): boolean {
  return PRIVILEGES.find((x) => x.id === p)?.scoped ?? false;
}

/** Whether `u` holds privilege `p`, for study `studyId` when the privilege is study-scoped. */
export function can(u: SessionUser, p: Privilege, studyId?: number | null): boolean {
  if (!u.privileges.includes(p)) return false;
  if (studyId == null || !isScoped(p) || u.studyScope === "*") return true;
  return u.studyScope.includes(studyId);
}

export function parseScope(raw: string): StudyScope {
  try {
    const v = JSON.parse(raw);
    if (v === "*") return "*";
    if (Array.isArray(v)) return v.filter((x) => Number.isInteger(x));
  } catch { /* fall through */ }
  return [];
}

export function parsePrivileges(raw: string): Privilege[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is Privilege => PRIVILEGE_IDS.includes(x));
  } catch { /* fall through */ }
  return [];
}
