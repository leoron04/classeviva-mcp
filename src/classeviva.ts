/**
 * Client minimale per l'API REST (non ufficiale) di ClasseViva / Spaggiari.
 * Base: https://web.spaggiari.eu/rest/v1 — gli header sono quelli dell'app Android.
 * Verificato su: Lioydiano/Classeviva-Official-Endpoints, franciuto/classeviva-mcp (MIT).
 */

export const DEFAULT_BASE = "https://web.spaggiari.eu/rest/v1";

export const API_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Z-Dev-ApiKey": "Tg1NWEwNGIgIC0K",
  "User-Agent": "CVVS/std/4.2.3 Android/12",
};

const SESSION_MS = 90 * 60 * 1000; // le sessioni durano 90 minuti
const MARGIN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export class ClasseVivaError extends Error {
  constructor(message: string, readonly status: number, readonly apiError?: string) {
    super(message);
    this.name = "ClasseVivaError";
  }
}

interface Session {
  token: string;
  studentId: string;
  ident: string;
  firstName?: string;
  lastName?: string;
  expiresAt: number;
}

export interface ClientConfig {
  user: string;
  pass: string;
  ident?: string; // opzionale: profilo da scegliere se l'account ne ha più di uno
  baseUrl?: string;
}

/** "S12345678X" -> "12345678": i percorsi /students/{id} vogliono solo le cifre. */
export function studentIdFromIdent(ident: string): string {
  const d = ident.replace(/\D/g, "");
  if (!d) throw new ClasseVivaError(`ident non valido: ${ident}`, 0);
  return d;
}

export class ClasseVivaClient {
  private session?: Session;
  private pending?: Promise<Session>;
  private readonly base: string;

  constructor(private readonly cfg: ClientConfig) {
    this.base = (cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  }

  private async fetchT(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      throw new ClasseVivaError(`Impossibile contattare ClasseViva: ${(e as Error).message}`, 0);
    } finally {
      clearTimeout(t);
    }
  }

  async login(): Promise<Session> {
    const doLogin = async (ident: string | null) => {
      const res = await this.fetchT(`${this.base}/auth/login`, {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({ ident, uid: this.cfg.user, pass: this.cfg.pass }),
      });
      if (res.status === 422) {
        const b = await safeJson(res);
        throw new ClasseVivaError(
          `Credenziali ClasseViva rifiutate (${b?.info ?? b?.error ?? "422"}). Se hai cambiato la password di ClasseViva, scollega e ricollega il connettore.`, 422, b?.error);
      }
      if (!res.ok) throw await toError(res);
      return (await res.json()) as any;
    };

    let data = await doLogin(this.cfg.ident ?? null);
    // Account con più profili (es. genitore con più figli): l'API chiede di sceglierne uno.
    if (!data.token && Array.isArray(data.choices) && data.choices.length) {
      const pick = data.choices.find((c: any) => c.ident === this.cfg.ident) ?? data.choices[0];
      data = await doLogin(pick.ident);
    }
    if (!data.token || !data.ident) throw new ClasseVivaError("Risposta di login inattesa", 502);

    const release = Date.parse(data.release);
    const expire = Date.parse(data.expire);
    this.session = {
      token: data.token,
      ident: data.ident,
      studentId: studentIdFromIdent(data.ident),
      firstName: data.firstName,
      lastName: data.lastName,
      expiresAt: Number.isFinite(expire) ? expire : (Number.isFinite(release) ? release : Date.now()) + SESSION_MS,
    };
    return this.session;
  }

  async ensureSession(): Promise<Session> {
    if (this.session && Date.now() < this.session.expiresAt - MARGIN_MS) return this.session;
    // evita login multipli in parallelo
    this.pending ??= this.login().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** Chiamata autenticata. `path` è relativo a /students/{id}/ */
  async student<T = any>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
    let s = await this.ensureSession();
    const call = (sess: Session) =>
      this.fetchT(`${this.base}/students/${sess.studentId}/${path}`, {
        method,
        headers: { ...API_HEADERS, "Z-Auth-Token": sess.token },
      });
    let res = await call(s);
    if (res.status === 401) {
      // token scaduto: rifaccio il login una volta
      this.session = undefined;
      s = await this.ensureSession();
      res = await call(s);
    }
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  get studentInfo() {
    return this.session;
  }
}

async function safeJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return undefined; }
}

async function toError(res: Response): Promise<ClasseVivaError> {
  const text = await res.text().catch(() => "");
  let body: any;
  try { body = JSON.parse(text); } catch { /* non JSON (es. pagina WAF) */ }
  const code: string | undefined = body?.error;
  if (code?.startsWith("122") || /dates must be/i.test(body?.message ?? ""))
    return new ClasseVivaError(
      `Intervallo di date non valido: ClasseViva accetta solo l'anno scolastico in corso${body?.message ? ` (${body.message})` : ""}`,
      res.status, code);
  if (code?.startsWith("120")) return new ClasseVivaError("Data malformata (usa YYYY-MM-DD)", res.status, code);
  if (res.status === 403 && !body)
    return new ClasseVivaError(
      "ClasseViva ha risposto 403 senza JSON: probabile blocco dell'indirizzo IP del server (WAF). Vedi README.",
      403);
  const detail = body?.message ?? body?.info ?? code ?? text.slice(0, 200);
  return new ClasseVivaError(`ClasseViva ha risposto ${res.status}${detail ? `: ${detail}` : ""}`, res.status, code);
}
