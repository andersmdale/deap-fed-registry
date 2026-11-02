/**
 * Account recovery from the server's shell.
 *   npm run cli -- reset-password <username>     temporary password, must be changed at next sign-in
 *   npm run cli -- make-admin <username>         give the user the Admin role and all studies
 *   npm run cli -- list-users
 *   npm run cli -- import-csv <file> [--dry-run]   add paths from a CSV export of the data-paths sheet
 *   npm run cli -- backup [file]                 consistent copy of the database (safe while the server runs)
 */
import fs from "node:fs";
import path from "node:path";
import { generatePassword, hashPassword } from "./auth.js";
import { audit, DATA_DIR, db, migrate } from "./db.js";
import { importCsv } from "./importCsv.js";

migrate();
const [cmd, name] = process.argv.slice(2);

function user(n: string | undefined) {
  if (!n) { console.error("Give a username."); process.exit(2); }
  const u = db.prepare("SELECT id, username FROM users WHERE username = ?").get(n) as { id: number; username: string } | undefined;
  if (!u) { console.error(`No user named ${n}.`); process.exit(1); }
  return u;
}

switch (cmd) {
  case "reset-password": {
    const u = user(name);
    const pw = generatePassword();
    db.prepare("UPDATE users SET password_hash=?, must_change_password=1, active=1, updated_at=? WHERE id=?").run(hashPassword(pw), Date.now(), u.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    audit({ userId: null, action: "password", entity: "user", entityId: u.id, summary: `temporary password set for ${u.username} from the server shell` });
    console.log(`Temporary password for ${u.username}: ${pw}\nThey must choose a new one when they sign in.`);
    break;
  }
  case "make-admin": {
    const u = user(name);
    const role = db.prepare("SELECT id FROM roles WHERE name = 'Admin'").get() as { id: number };
    db.prepare(`UPDATE users SET role_id=?, study_scope='"*"', active=1, updated_at=? WHERE id=?`).run(role.id, Date.now(), u.id);
    audit({ userId: null, action: "update", entity: "user", entityId: u.id, summary: `${u.username} made Admin from the server shell` });
    console.log(`${u.username} is now an Admin with access to all studies.`);
    break;
  }
  case "list-users": {
    const rows = db.prepare("SELECT u.username, u.display_name, r.name AS role, u.active FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username").all() as
      { username: string; display_name: string; role: string; active: number }[];
    for (const r of rows) console.log(`${r.username.padEnd(20)} ${r.role.padEnd(12)} ${r.active ? "active" : "deactivated"}  ${r.display_name}`);
    if (!rows.length) console.log("No users yet.");
    break;
  }
  case "backup": {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const file = path.resolve(name || path.join(DATA_DIR, "backups", `registry-${stamp}.db`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) { console.error(`${file} already exists.`); process.exit(1); }
    db.prepare("VACUUM INTO ?").run(file);
    console.log(`Backed up the registry to ${file}`);
    break;
  }
  case "import-csv": {
    if (!name) { console.error("Give the CSV file: npm run cli -- import-csv imports/<file>.csv [--dry-run]"); process.exit(2); }
    const dryRun = process.argv.includes("--dry-run");
    const rep = importCsv(path.resolve(process.env.INIT_CWD || process.cwd(), name), { dryRun });
    const show = (title: string, xs: string[]) => { if (xs.length) { console.log(`\n${title} (${xs.length}):`); xs.forEach((x) => console.log("  " + x)); } };
    show(dryRun ? "Would add" : "Added", rep.created);
    show(dryRun ? "Would mark N/A" : "Marked N/A", rep.notApplicable);
    show("Already recorded, left alone", rep.skipped);
    show("Unknown in the sheet (???), skipped", rep.unknown);
    show("Problems", rep.problems);
    console.log(dryRun ? "\nDry run: nothing was changed." : "\nDone. Reload the registry page to see the changes.");
    break;
  }
  default:
    console.log("Commands: reset-password <username> | make-admin <username> | list-users | backup [file] | import-csv <file> [--dry-run]");
}
