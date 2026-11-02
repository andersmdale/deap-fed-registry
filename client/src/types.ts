export type Privilege =
  | "users.manage" | "studies.manage" | "categories.manage" | "locations.edit" | "locations.ready" | "workflows.manage" | "runs.record";
export type StudyScope = "*" | number[];

export interface PrivilegeInfo { id: Privilege; label: string; scoped: boolean }

export interface Me {
  id: number; username: string; displayName: string; email: string; roleId: number; roleName: string;
  privileges: Privilege[]; studyScope: StudyScope; mustChangePassword: boolean;
}

export interface Study {
  id: number; code: string; name: string; release: string; tre: string; access: "tre" | "sumstats" | "other";
  defaultHost: string; description: string; sortOrder: number; archived: boolean; updatedAt: number; updatedBy: number | null;
}

export interface Category {
  id: number; parentId: number | null; code: string; label: string; description: string; sortOrder: number;
  archived: boolean; updatedAt: number; updatedBy: number | null;
}

export interface Location {
  id: number; studyId: number; categoryId: number; kind: "directory" | "file"; host: string; path: string; format: string;
  version: string; notes: string; ready: boolean; readyBy: number | null; readyAt: number | null; producedByRun: number | null;
  archived: boolean; createdAt: number; createdBy: number | null; updatedAt: number; updatedBy: number | null;
}

export interface Cell { studyId: number; categoryId: number; notApplicable: boolean; note: string; updatedAt: number; updatedBy: number | null }

export interface Workflow {
  id: number; name: string; description: string; host: string; tool: string; version: string; command: string; otherOutputs: string;
  sortOrder: number; archived: boolean; updatedAt: number; updatedBy: number | null; inputs: number[]; outputs: number[];
}

export interface RunInputs {
  categories: number[];
  locations: { locationId: number; categoryId: number; updatedAt: number; host: string; path: string; ready: boolean }[];
}

export interface Run {
  id: number; workflowId: number; studyId: number; status: "completed" | "running" | "failed"; host: string; outputPath: string;
  version: string; notes: string; inputs: RunInputs; createdAt: number; createdBy: number | null; updatedAt: number; updatedBy: number | null;
}

export interface Role { id: number; name: string; description: string; privileges: Privilege[]; builtin: boolean; users: number; updatedAt: number }

export interface Person { id: number; username: string; displayName: string; active: boolean }

export interface UserRecord {
  id: number; username: string; displayName: string; email: string; roleId: number; studyScope: StudyScope; active: boolean;
  mustChangePassword: boolean; lastLoginAt: number | null; createdAt: number; createdBy: number | null; updatedAt: number;
}

export interface AuditEntry {
  id: number; ts: number; userId: number | null; action: string; entity: string; entityId: number | null;
  studyId: number | null; categoryId: number | null; summary: string;
}

export interface RegistryState {
  me: Me; privileges: PrivilegeInfo[]; studies: Study[]; categories: Category[]; locations: Location[]; cells: Cell[];
  workflows: Workflow[]; runs: Run[]; roles: Role[]; people: Person[];
}
