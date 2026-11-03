import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSetupToken, loadUser, requireAuth } from "./auth.js";
import { DATA_DIR, migrate } from "./db.js";
import { HttpError } from "./http.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { dataRoutes } from "./routes/data.js";
import { workflowRoutes } from "./routes/workflows.js";
import { tlsFiles } from "./tls.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.REGISTRY_PORT || 8095);
const HOST = process.env.REGISTRY_HOST || "0.0.0.0";

migrate();

export const app = express();
app.disable("x-powered-by");
if (process.env.REGISTRY_TRUST_PROXY === "1") app.set("trust proxy", 1);
const tls = tlsFiles();
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (tls || process.env.REGISTRY_SECURE_COOKIES === "1") res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
});
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
  let server: net.Server;
  if (tls) {
    // One port for both: TLS handshakes go to HTTPS; plain HTTP gets a redirect to the https:// address.
    const secure = https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, app);
    const redirect = http.createServer((req, res) => {
      res.writeHead(301, { Location: `https://${req.headers.host || `localhost:${PORT}`}${req.url || "/"}` }).end();
    });
    server = net.createServer((sock) => {
      sock.once("data", (buf) => {
        sock.pause();
        sock.unshift(buf);
        (buf[0] === 0x16 ? secure : redirect).emit("connection", sock);
        process.nextTick(() => sock.resume());
      });
      sock.on("error", () => sock.destroy());
    });
  } else {
    server = http.createServer(app);
  }
  server.listen(PORT, HOST, () => {
    const scheme = tls ? "https" : "http";
    console.log(`DEAP-Fed Data Registry on ${scheme}://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (data in ${DATA_DIR})`);
    console.log(tls ? `TLS certificate ${tls.cert}` : "Plain HTTP: no certificate found. Run scripts/tls.sh to enable HTTPS.");
    if (!fs.existsSync(dist)) console.log("Client not built yet: run `npm run build` in the repo root.");
    const tokenFile = ensureSetupToken();
    if (tokenFile) console.log(`No accounts yet. Open the site and create the first admin with the setup token in ${tokenFile}`);
  });
  // Optional: answer plain HTTP on another port (e.g. 80 or 8094) with a redirect to the HTTPS address.
  const redirectPort = Number(process.env.REGISTRY_HTTP_REDIRECT_PORT || 0);
  if (tls && redirectPort) {
    http.createServer((req, res) => {
      const host = (req.headers.host || "localhost").replace(/:\d+$/, "");
      res.writeHead(301, { Location: `https://${host}:${PORT}${req.url || "/"}` }).end();
    }).listen(redirectPort, HOST, () => console.log(`Redirecting http://…:${redirectPort} to HTTPS`));
  }
}
