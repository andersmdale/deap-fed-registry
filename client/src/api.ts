export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
/** Called when the server says the session is gone or a password change is due. */
export function onAuthProblem(fn: Listener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api" + url, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-requested-with": "registry" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the registry server. Check that it is running and you are on the network.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, json.error || `Request failed (${res.status})`, json.code);
    if (!url.startsWith("/auth/") && (err.code === "unauthenticated" || err.code === "password_change_required")) authListeners.forEach((l) => l(err));
    throw err;
  }
  return json as T;
}

export const get = <T,>(url: string) => api<T>("GET", url);
export const post = <T,>(url: string, body?: unknown) => api<T>("POST", url, body ?? {});
export const put = <T,>(url: string, body?: unknown) => api<T>("PUT", url, body ?? {});
export const del = <T,>(url: string) => api<T>("DELETE", url);
