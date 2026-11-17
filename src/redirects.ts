import type { Env } from "./env.js";

/**
 * Allowlist opzionale dei redirect_uri OAuth (ALLOWED_REDIRECTS, separati da virgola: URL esatti, oppure prefissi
 * che finiscono con "/"). Se impostata, un sito estraneo non può registrare un client che riceve il codice OAuth
 * (phishing "consenti l'accesso"). Il loopback (localhost/127.0.0.1/[::1], app desktop e CLI) è sempre ammesso.
 * Se vuota, qualsiasi redirect_uri https è accettato (comportamento predefinito per le istanze pubbliche).
 */
export function redirectAllowed(env: Pick<Env, "ALLOWED_REDIRECTS">, uri: string): boolean {
  const list = (env.ALLOWED_REDIRECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if ((u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
  if (u.protocol !== "https:") return false;
  return list.some((p) => uri === p || (p.endsWith("/") && uri.startsWith(p)));
}

/** Controlla il body di POST /register (RFC 7591). Ritorna una Response d'errore o null se va bene. */
export async function checkRegistration(req: Request, env: Env): Promise<Response | null> {
  if (!(env.ALLOWED_REDIRECTS ?? "").trim()) return null;
  let body: any;
  try { body = await req.clone().json(); } catch { return null; } // il provider risponderà con l'errore giusto
  const uris: unknown[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
  const bad = uris.filter((u) => typeof u !== "string" || !redirectAllowed(env, u));
  if (!uris.length || bad.length)
    return Response.json(
      { error: "invalid_redirect_uri", error_description: "redirect_uri non consentito su questa istanza" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  return null;
}

/** true se l'username è ammesso (ALLOWED_USERS vuoto = istanza aperta). */
export function userAllowed(env: Pick<Env, "ALLOWED_USERS">, user: string): boolean {
  const allowed = (env.ALLOWED_USERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !allowed.length || allowed.includes(user.trim().toLowerCase());
}
