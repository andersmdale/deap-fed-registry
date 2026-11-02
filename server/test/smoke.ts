/* End-to-end check of the API against a throwaway database: npm test */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
process.env.REGISTRY_DATA = dir;
process.env.REGISTRY_NO_LISTEN = "1";
const { app } = await import("../src/index.js");
const { ensureSetupToken } = await import("../src/auth.js");
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

class Client {
  cookie = "";
  async call(method: string, url: string, body?: unknown, expect = 200) {
    const res = await fetch(base + url, {
      method, headers: { "content-type": "application/json", "x-requested-with": "registry", cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const json = await res.json().catch(() => null);
    assert.equal(res.status, expect, `${method} ${url} → ${res.status} ${JSON.stringify(json)}`);
    return json as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
}

let passed = 0;
const step = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log("ok  " + name); };

const admin = new Client();
const alice = new Client();
let state: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let aliceId = 0, tempPw = "";

try {
  await step("setup needs the token from data/setup-token.txt", async () => {
    const file = ensureSetupToken()!;
    assert.equal((await admin.call("GET", "/auth/setup")).needed, true);
    await admin.call("POST", "/auth/setup", { token: "wrong", username: "dale", password: "correct horse battery" }, 403);
    const token = fs.readFileSync(file, "utf8").trim();
    await admin.call("POST", "/auth/setup", { token, username: "dale", displayName: "Anders Dale", password: "correct horse battery" });
    assert.equal(fs.existsSync(file), false);
    await admin.call("POST", "/auth/setup", { token, username: "x", password: "correct horse battery" }, 409);
  });

  await step("state carries the seeded studies, categories, locations and workflows", async () => {
    state = await admin.call("GET", "/state");
    assert.equal(state.studies.length, 11);
    assert.equal(state.categories.length, 12);
    assert.ok(state.locations.length >= 8);
    assert.equal(state.workflows.length, 6);
    assert.equal(state.me.roleName, "Admin");
  });

  await step("mutations without the header are refused", async () => {
    const res = await fetch(base + "/studies", { method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: "{}" });
    assert.equal(res.status, 403);
  });

  await step("admin adds a Processor scoped to ABCD; she must change her password", async () => {
    const processor = state.roles.find((r: any) => r.name === "Processor"); // eslint-disable-line @typescript-eslint/no-explicit-any
    const abcd = state.studies.find((s: any) => s.code === "ABCD"); // eslint-disable-line @typescript-eslint/no-explicit-any
    const out = await admin.call("POST", "/admin/users", { username: "alice", displayName: "Alice", roleId: processor.id, studyScope: [abcd.id] });
    aliceId = out.user.id; tempPw = out.temporaryPassword;
    await alice.call("POST", "/auth/login", { username: "alice", password: "nope-nope-nope" }, 401);
    await alice.call("POST", "/auth/login", { username: "alice", password: tempPw });
    await alice.call("GET", "/state", undefined, 403);
    await alice.call("POST", "/auth/password", { current: tempPw, next: "alice's new password" });
    await alice.call("GET", "/state");
  });

  const abcd = () => state.studies.find((s: any) => s.code === "ABCD").id; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ukb = () => state.studies.find((s: any) => s.code === "UKB").id; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cat = (code: string) => state.categories.find((c: any) => c.code === code).id; // eslint-disable-line @typescript-eslint/no-explicit-any
  let mriLoc = 0;

  await step("processor edits paths in scope only, and can't mark Ready", async () => {
    const loc = await alice.call("POST", "/locations", { studyId: abcd(), categoryId: cat("mri"), path: "/space/ceph/1/ABCD/raw/mri", host: "beast2" });
    mriLoc = loc.id;
    await alice.call("POST", "/locations", { studyId: ukb(), categoryId: cat("mri"), path: "/x" }, 403);
    await alice.call("POST", `/locations/${loc.id}/ready`, { ready: true }, 403);
    await alice.call("POST", "/studies", { code: "NEW", name: "New" }, 403);
  });

  await step("admin marks Ready; moving the path clears it; history records who and what", async () => {
    let loc = await admin.call("POST", `/locations/${mriLoc}/ready`, { ready: true });
    assert.equal(loc.ready, true);
    loc = await alice.call("PUT", `/locations/${mriLoc}`, { kind: "directory", host: "beast2", path: "/space/ceph/1/ABCD/raw/mri_v2" });
    assert.equal(loc.ready, false);
    const hist = await admin.call("GET", `/audit?entity=location&entityId=${mriLoc}`);
    assert.equal(hist.entries.length, 3);
    assert.match(hist.entries[0].summary, /Ready withdrawn/);
    assert.equal(hist.entries[0].userId, aliceId);
  });

  await step("recording a run snapshots inputs and creates the output location", async () => {
    const mmps = state.workflows.find((w: any) => w.name === "MMPS processing"); // eslint-disable-line @typescript-eslint/no-explicit-any
    const out = await alice.call("POST", "/runs", { workflowId: mmps.id, studyId: abcd(), host: "beast2", outputPath: "/space/ceph/1/ABCD/mmps",
      createOutputs: [{ categoryId: cat("mmps"), kind: "directory" }] });
    assert.equal(out.run.inputs.locations.length, 1);
    assert.equal(out.locations[0].producedByRun, out.run.id);
    await alice.call("POST", "/runs", { workflowId: mmps.id, studyId: ukb(), outputPath: "/x" }, 403);
  });

  await step("N/A, categories, roles and the last-admin guard", async () => {
    await admin.call("PUT", `/cells/${ukb()}/${cat("pet")}`, { notApplicable: true, note: "No PET in UKB imaging" });
    const c = await admin.call("POST", "/categories", { parentId: cat("raw"), code: "eeg", label: "EEG" });
    await admin.call("POST", "/categories", { parentId: c.id, code: "deep", label: "Too deep" }, 400);
    const adminRole = state.roles.find((r: any) => r.name === "Admin"); // eslint-disable-line @typescript-eslint/no-explicit-any
    await admin.call("PUT", `/admin/roles/${adminRole.id}`, { name: "Admin", description: "", privileges: ["studies.manage"] }, 400);
    await admin.call("DELETE", `/admin/roles/${adminRole.id}`, undefined, 400);
    await alice.call("GET", "/admin/users", undefined, 403);
  });

  await step("deactivating a user ends their session", async () => {
    const users = await admin.call("GET", "/admin/users");
    const a = users.find((u: any) => u.username === "alice"); // eslint-disable-line @typescript-eslint/no-explicit-any
    await admin.call("PUT", `/admin/users/${a.id}`, { displayName: a.displayName, email: "", roleId: a.roleId, studyScope: a.studyScope, active: false });
    await alice.call("GET", "/state", undefined, 401);
    const me = await admin.call("GET", "/auth/me");
    await admin.call("PUT", `/admin/users/${me.user.id}`, { displayName: "x", email: "", roleId: me.user.roleId, studyScope: "*", active: false }, 400);
  });

  console.log(`\n${passed} checks passed`);
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
