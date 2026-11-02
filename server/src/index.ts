import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSetupToken, loadUser, requireAuth } from "./auth.js";
import { DATA_DIR, migrate } from "./db.js";
import { HttpError } from "./http.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { dataRoutes } from "./routes/data.js";
import { workflowRoutes } from "./routes/workflows.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.REGISTRY_PORT || 8095);
const HOST = process.env.REGISTRY_HOST || "0.0.0.0";

migrate();

export const app = express();
app.disable("x-powered-by");
if (process.env.REGISTRY_TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// Every state-changing API call must carry this header; browsers won't send it cross-site without CORS approval.
app.use("/api", (req, _res, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("x-requested-with") !== "registry") {
    return next(new HttpError(403, "Missing X-Requested-With header"));
  }
  next();
});
app.use("/api", loadUser);
app.use("/api/auth", authRoutes());
app.use("/api", requireAuth);
app.use("/api", dataRoutes());
app.use("/api", workflowRoutes());
app.use("/api/admin", adminRoutes());
app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found")));

const dist = path.resolve(here, "../../client/dist");
if (fs.existsSync(dist)) {
  app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "30d" }));
  app.use(express.static(dist, { index: false, maxAge: 0 }));
  app.get("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(dist, "index.html"));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof SyntaxError) return res.status(400).json({ error: "Request body isn't valid JSON" });
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/.test(msg)) return res.status(409).json({ error: "That would duplicate an existing record" });
  console.error(err);
  res.status(500).json({ error: "Server error: " + msg });
});

if (process.env.REGISTRY_NO_LISTEN !== "1") {
  app.listen(PORT, HOST, () => {
    console.log(`DEAP-Fed Data Registry on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (data in ${DATA_DIR})`);
    if (!fs.existsSync(dist)) console.log("Client not built yet: run `npm run build` in the repo root.");
    const tokenFile = ensureSetupToken();
    if (tokenFile) console.log(`No accounts yet. Open the site and create the first admin with the setup token in ${tokenFile}`);
  });
}
