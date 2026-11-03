import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";

/**
 * HTTPS settings. The server uses TLS when a certificate and key are found:
 *   REGISTRY_TLS_CERT / REGISTRY_TLS_KEY, or else <data>/tls/cert.pem and <data>/tls/key.pem
 *   (written by scripts/tls.sh). Set REGISTRY_TLS=off to force plain HTTP, e.g. behind a TLS proxy.
 */
export const TLS_DIR = path.join(DATA_DIR, "tls");

export function tlsFiles(): { cert: string; key: string } | null {
  if (process.env.REGISTRY_TLS === "off") return null;
  const cert = process.env.REGISTRY_TLS_CERT || path.join(TLS_DIR, "cert.pem");
  const key = process.env.REGISTRY_TLS_KEY || path.join(TLS_DIR, "key.pem");
  if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  if (process.env.REGISTRY_TLS_CERT || process.env.REGISTRY_TLS_KEY) {
    throw new Error(`REGISTRY_TLS_CERT/REGISTRY_TLS_KEY point at files that don't exist (${cert}, ${key})`);
  }
  return null;
}

export const TLS_ON = tlsFiles() !== null;
