/**
 * Modalità LEGACY (deprecata, opzionale): endpoint single-user /mcp/<MCP_SECRET> con le credenziali
 * nei secret del Worker. Attiva solo se CLASSEVIVA_USER, CLASSEVIVA_PASS e MCP_SECRET sono impostati.
 * Per i nuovi utenti usa /mcp con OAuth.
 */
import type { Env } from "./env.js";
import { clientFor } from "./clients.js";
import { handleMcp } from "./mcp.js";

export const LEGACY_PATH = /^\/mcp\/([^/]+)\/?$/;

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const notFound = () =>
  new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });

export async function handleLegacy(req: Request, env: Env, secretFromPath: string): Promise<Response> {
  const secret = env.MCP_SECRET ?? "";
  if (secret.length < 24 || !env.CLASSEVIVA_USER || !env.CLASSEVIVA_PASS) return notFound();
  let given: string;
  try { given = decodeURIComponent(secretFromPath); } catch { return notFound(); }
  if (!timingSafeEqual(given, secret)) return notFound();

  const client = await clientFor({
    user: env.CLASSEVIVA_USER, pass: env.CLASSEVIVA_PASS,
    ident: env.CLASSEVIVA_IDENT || undefined, baseUrl: env.CLASSEVIVA_BASE_URL || undefined,
  });
  return handleMcp(req, () => client);
}
