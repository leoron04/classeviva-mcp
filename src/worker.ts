import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize, SCOPE } from "./authorize.js";
import { clientFor } from "./clients.js";
import type { Env, GrantProps } from "./env.js";
import { handleMcp, VERSION } from "./mcp.js";
import { homePage } from "./pages.js";
import { checkRegistration, userAllowed } from "./redirects.js";

/** Endpoint MCP protetto da OAuth: ogni utente vede solo il proprio registro (credenziali nelle props cifrate del token). */
const mcpApi = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
    const p = ctx.props as GrantProps | undefined;
    if (!p?.u || !p?.p) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
    // ALLOWED_USERS vale anche per i token già emessi (es. se l'elenco cambia dopo il login)
    if (!userAllowed(env, p.u)) return Response.json({ error: "access_denied", error_description: "utente non ammesso su questa istanza" }, { status: 403 });
    const client = await clientFor({ user: p.u, pass: p.p, ident: p.i, baseUrl: env.CLASSEVIVA_BASE_URL || undefined });
    const num = (v?: string) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
    return handleMcp(req, () => client, {
      oreSettimanali: num(env.ORE_SETTIMANALI), monteOre: num(env.MONTE_ORE_ANNUO), percentuale: num(env.LIMITE_ASSENZE_PERCENT),
    });
  },
};

/** Tutto ciò che non è /mcp: pagina di login OAuth, home, health. */
const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/authorize") return handleAuthorize(req, env);
    if (url.pathname === "/health")
      return Response.json({ ok: true, name: "classeviva-mcp", version: VERSION });
    if (url.pathname === "/" && req.method === "GET") return homePage(publicOrigin(env, req));
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

function publicOrigin(env: Env, req: Request): string {
  return (env.PUBLIC_URL || new URL(req.url).origin).replace(/\/+$/, "").toLowerCase();
}

const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApi as any,
      defaultHandler: defaultHandler as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      clientIdMetadataDocumentEnabled: true, // client con Client ID Metadata Document (es. versioni recenti di Claude)
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "ClasseViva (non ufficiale)",
      },
      accessTokenTTL: 60 * 60, // 1 ora
      refreshTokenTTL: 60 * 24 * 3600, // 60 giorni per un grant nuovo...
      refreshTokenIdleTTL: 60 * 24 * 3600, // ...prorogati a ogni refresh: scade solo se inutilizzato per 60 giorni
      onError: ({ status, code, internal }) => {
        // nessun dato sensibile nei log: solo codice e status
        console.warn(`oauth error ${status} ${code} ${internal?.category}/${internal?.reason}`);
      },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/register" && req.method === "POST") {
      const bad = await checkRegistration(req, env);
      if (bad) return bad;
    }
    return providerFor(publicOrigin(env, req)).fetch(req, env, ctx);
  },
};
