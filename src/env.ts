import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** KV usato da workers-oauth-provider (client, grant, token: solo hash e props cifrate). */
  OAUTH_KV: KVNamespace;
  /** Iniettato da OAuthProvider nel defaultHandler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Rate limiting dei tentativi di login (binding Workers Rate Limiting, opzionale). */
  LOGIN_LIMITER?: RateLimit;
  /** URL pubblico del servizio (es. https://classeviva-mcp.tuonome.workers.dev). Se manca usa l'origin della richiesta. */
  PUBLIC_URL?: string;
  /** Segreto (>= 32 caratteri) per derivare un userId pseudonimo dall'username (HMAC). Opzionale ma consigliato. */
  SUBJECT_KEY?: string;
  /** Elenco (separato da virgole) degli username ClasseViva ammessi. Se vuoto, l'istanza è aperta a tutti. */
  ALLOWED_USERS?: string;
  /** Base URL alternativa dell'API Spaggiari (es. un proxy). */
  CLASSEVIVA_BASE_URL?: string;

  /** Predefiniti per get_absence_hours (opzionali; il tool li accetta anche come parametri). */
  ORE_SETTIMANALI?: string;
  MONTE_ORE_ANNUO?: string;
  LIMITE_ASSENZE_PERCENT?: string;
  /** Allowlist opzionale dei redirect_uri OAuth (vedi redirects.ts). */
  ALLOWED_REDIRECTS?: string;
}

/** Ciò che viene salvato (cifrato) dentro il grant OAuth. Visibile solo a chi possiede il token. */
export interface GrantProps {
  v: 1;
  u: string; // username ClasseViva
  p: string; // password ClasseViva
  i?: string; // ident del profilo (es. S1234567X)
}
