import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { Privilege, SessionUser } from "./privileges.js";
import { can } from "./privileges.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Wrap a handler so thrown errors reach the error middleware. */
export const h = (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.catch(next);
    } catch (e) {
      next(e);
    }
  };

export function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `${i.path.join(".") || "request"}: ${i.message}`);
  }
  return r.data;
}

export function idParam(req: Request, name = "id"): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function me(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, "Sign in first", "unauthenticated");
  return req.user;
}

export function requirePriv(req: Request, p: Privilege, studyId?: number | null): SessionUser {
  const u = me(req);
  if (!can(u, p, studyId)) {
    throw new HttpError(403, studyId != null && u.privileges.includes(p)
      ? "This study is outside your study scope"
      : "Your role doesn't include this privilege");
  }
  return u;
}

export const text = (max = 2000) => z.string().trim().max(max);
export const optText = (max = 2000) => z.string().trim().max(max).optional().default("");
