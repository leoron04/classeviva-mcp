import { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { ClasseVivaClient, ClasseVivaError } from "./classeviva.js";
import { remember } from "./clients.js";
import type { Env, GrantProps } from "./env.js";
import { errorPage, loginPage, SECURITY_HEADERS } from "./pages.js";

export const SCOPE = "classeviva:read";

function withSecurity(h: Headers): Headers {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return h;
}

/** Copia i Set-Cookie (e gli altri header) di `from` dentro `to` senza sovrascrivere i cookie già presenti. */
function mergeHeaders(to: Headers, from: Headers): Headers {
  for (const c of from.getSetCookie()) to.append("Set-Cookie", c);
  from.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") to.set(k, v); });
  return to;
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * userId del grant: NON cifrato nel KV, quindi pseudonimo. HMAC(SUBJECT_KEY, username|profilo) se la chiave
 * è configurata (permette di revocare i grant vecchi dello stesso utente), altrimenti un id casuale.
 */
async function subjectFor(env: Env, user: string, ident: string): Promise<string> {
  if (env.SUBJECT_KEY && env.SUBJECT_KEY.length >= 32)
    return "u_" + (await hmacHex(env.SUBJECT_KEY, `${user.toLowerCase()}|${ident.toUpperCase()}`)).slice(0, 40);
  return "r_" + crypto.randomUUID();
}

async function sha256Hex(s: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** true se il tentativo è consentito. Limita per IP e per username (hash), così si frenano forza bruta e credential stuffing. */
async function allowAttempt(env: Env, req: Request, user: string): Promise<boolean> {
  if (!env.LOGIN_LIMITER) return true;
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const [a, b] = await Promise.all([
    env.LOGIN_LIMITER.limit({ key: `ip:${ip}` }),
    env.LOGIN_LIMITER.limit({ key: `user:${(await sha256Hex(user.toLowerCase())).slice(0, 32)}` }),
  ]);
  return a.success && b.success;
}

/**
 * Contatore dei login FALLITI per username, su KV (scrive solo quando un login fallisce).
 * Il rate limiting Workers è "permissivo" e per-location; questo è un tetto più rigido contro la forza bruta
 * su un singolo account. La chiave è un HMAC/hash dell'username, mai l'username in chiaro.
 */
const FAIL_MAX = 8, FAIL_WINDOW_S = 15 * 60;
async function failKey(env: Env, user: string): Promise<string> {
  const id = env.SUBJECT_KEY && env.SUBJECT_KEY.length >= 32
    ? await hmacHex(env.SUBJECT_KEY, `fail|${user.toLowerCase()}`)
    : await sha256Hex(`fail|${user.toLowerCase()}`);
  return `cvfail:${id.slice(0, 40)}`;
}
async function tooManyFailures(env: Env, user: string): Promise<boolean> {
  const n = Number(await env.OAUTH_KV.get(await failKey(env, user))) || 0;
  return n >= FAIL_MAX;
}
async function recordFailure(env: Env, user: string): Promise<void> {
  const k = await failKey(env, user);
  const n = Number(await env.OAUTH_KV.get(k)) || 0;
  await env.OAUTH_KV.put(k, String(n + 1), { expirationTtl: FAIL_WINDOW_S });
}

function handleError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError)
    return errorPage(`Richiesta di autorizzazione non valida o scaduta (${e.description}).`);
  if (e instanceof CimdFetchError) return errorPage("Non è stato possibile verificare l'app che chiede l'accesso.");
  throw e;
}

async function renderLogin(env: Env, authReq: AuthRequest, extra: Headers | undefined, opts: Parameters<typeof loginPage>[2], status = 200) {
  const oauth = env.OAUTH_PROVIDER;
  const details = await oauth.describeConsent(authReq);
  const consent = await oauth.beginConsent(authReq);
  const headers = withSecurity(extra ? mergeHeaders(new Headers(), extra) : new Headers());
  mergeHeaders(headers, consent.headers);
  withSecurity(headers);
  return new Response(loginPage(details, consent.handle, opts), { status, headers });
}

export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "GET") {
      const authReq = await oauth.parseAuthRequest(req);
      return await renderLogin(env, authReq, undefined, {});
    }
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });

    // CSRF: oltre al "handle" legato al cookie __Host- (verificato da approveConsent), rifiuta POST cross-origin.
    const origin = req.headers.get("Origin");
    if (origin && origin !== new URL(req.url).origin) return errorPage("Richiesta non valida (origine diversa).", 403);
    const ctype = req.headers.get("content-type") ?? "";
    if (!ctype.includes("application/x-www-form-urlencoded") && !ctype.includes("multipart/form-data"))
      return errorPage("Richiesta non valida.", 400);

    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const user = String(form.get("username") ?? "").trim().slice(0, 200);
    const pass = String(form.get("password") ?? "").slice(0, 200);
    const identIn = String(form.get("ident") ?? "").trim().toUpperCase().slice(0, 40);

    // Consuma il handle (CSRF + binding al browser). In caso di errore ne apriamo uno nuovo.
    const approved = await oauth.approveConsent(req, handle, { scope: [SCOPE] });
    const retry = (error: string, status = 200) =>
      renderLogin(env, approved.request, approved.headers, { error, user, ident: identIn }, status);

    if (!user || !pass) return retry("Inserisci codice utente e password.");
    if (identIn && !/^[A-Z]?\d+[A-Z]?$/.test(identIn)) return retry("Codice profilo non valido (es. S1234567X).");
    if (!(await allowAttempt(env, req, user)))
      return retry("Troppi tentativi di accesso. Aspetta un minuto e riprova.", 429);
    if (await tooManyFailures(env, user))
      return retry("Troppi tentativi falliti per questo account. Riprova tra 15 minuti.", 429);

    const creds = { user, pass, ident: identIn || undefined, baseUrl: env.CLASSEVIVA_BASE_URL || undefined };
    const client = new ClasseVivaClient(creds);
    let ident: string;
    try {
      ident = (await client.login()).ident;
    } catch (e) {
      // Nessun log delle credenziali: al massimo lo status.
      if (e instanceof ClasseVivaError && e.status === 422) {
        await recordFailure(env, user);
        return retry("Credenziali ClasseViva errate. Controlla codice utente e password.");
      }
      if (e instanceof ClasseVivaError && e.status === 403) return retry("ClasseViva ha bloccato temporaneamente la richiesta. Riprova tra qualche minuto.");
      console.warn("login ClasseViva fallito", e instanceof ClasseVivaError ? e.status : "errore");
      return retry("ClasseViva non risponde in questo momento. Riprova tra poco.");
    }
    if (identIn && ident.replace(/\D/g, "") !== identIn.replace(/\D/g, ""))
      return retry("Il codice profilo indicato non appartiene a questo account.");

    const props: GrantProps = { v: 1, u: user, p: pass, i: ident };
    await remember({ user, pass, ident, baseUrl: creds.baseUrl }, client);

    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: await subjectFor(env, user, ident),
      metadata: { kind: "classeviva" },
      scope: approved.request.scope,
      props,
    });
    const headers = withSecurity(mergeHeaders(new Headers(), approved.headers));
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return handleError(e);
  }
}
