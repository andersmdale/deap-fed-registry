# DEAP-Fed Data Registry

A web app that records, for every study DEAP-Fed works with, where each category of data lives, who signed it off as Ready, and which workflow produced it.

- **Users, roles and privileges.** Admins add accounts and give each person a role and a study scope. Roles bundle privileges; the per-study privileges (edit paths, mark Ready, record runs) apply only to the studies in the person's scope.
- **Studies** with their DEAP-Fed TRE, access type and default host.
- **Data categories** in two levels. *Raw data* holds tabulated data, data dictionary, MRI scans, PET scans and genotyping / sequencing. *Derived data* holds MMPS results, NeuroQuant results, atlas-registered MMPS, concatenated imaging and SVD. Admins can add, rename, reorder or archive categories.
- **Paths.** Each study × category can hold any number of directories or files, each with host, format, release and notes. A category can be marked N/A for a study.
- **Ready sign-off** per path, recording who and when. Moving a path clears its sign-off.
- **Workflows** with input and output categories. Recording a run snapshots its inputs and can register the output location. When an input changes later, the output is flagged *Inputs changed*.
- **History.** Every change is logged with person, time and a before/after summary. You can see it per record and on the Activity page.

Stack: React + TypeScript (Vite) client, Node + Express + TypeScript server, and Node's built-in SQLite (`node:sqlite`, so there is no native module to compile). One process serves both the API and the built client.

## Install on the Mac Pro

Requires Node.js 22.13 or newer (`node -v`).

```bash
cd ~/Dropbox/github/deap-fed-registry
scripts/install-mac.sh
```

The script:
- builds the app
- installs a launchd service (`org.deapfed.registry`) that starts at login and restarts if it stops
- serves the app on port 8095
- keeps the database in `~/deap-fed-registry-data`

The database deliberately lives outside Dropbox, because syncing a live SQLite file can corrupt it. Change the port or data folder with `REGISTRY_PORT=… REGISTRY_DATA=… scripts/install-mac.sh`.

On first start there are no accounts. The installer prints a one-time setup token, which is also in `~/deap-fed-registry-data/setup-token.txt`. Open `http://localhost:8095` (or `http://169.228.56.236:8095` from another machine) and create the first admin with it. Add everyone else under **People & roles**. Each new user gets a temporary password and chooses their own at first sign-in.

## Update after code changes

```bash
cd ~/Dropbox/github/deap-fed-registry && scripts/deploy.sh
```

## Day-to-day commands (on the Mac Pro)

```bash
cd ~/Dropbox/github/deap-fed-registry
npm run cli -- list-users
npm run cli -- reset-password <username>     # prints a temporary password
npm run cli -- make-admin <username>         # if every admin is locked out
npm run cli -- backup                        # copy to ~/deap-fed-registry-data/backups/
npm run cli -- import-csv imports/<file>.csv --dry-run   # preview adding paths from a sheet export
npm run cli -- import-csv imports/<file>.csv             # add them (safe to re-run; existing paths are left alone)
launchctl kickstart -k gui/$(id -u)/org.deapfed.registry   # restart
tail -f ~/deap-fed-registry-data/registry.log
```

## Security notes

- Passwords are hashed with scrypt. Sessions are HttpOnly, SameSite=Lax cookies that last 12 hours (`REGISTRY_SESSION_HOURS`). Five failed sign-ins lock that username and address out for 15 minutes.
- The server speaks plain HTTP. Use it on the campus network or VPN, or put it behind a TLS proxy and set `REGISTRY_SECURE_COOKIES=1` and `REGISTRY_TRUST_PROXY=1`.
- The registry stores paths and metadata only, never study data.

## Development

```bash
npm install
npm run dev:server          # API on :8095, reloads on change
npm run dev:client          # UI on :5173, proxies /api to :8095
npm test                    # API end-to-end checks on a throwaway database
```
