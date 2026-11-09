import { ClasseVivaClient } from "./classeviva.js";

/**
 * Cache in memoria (per isolate) dei client ClasseViva, così la sessione Spaggiari
 * (valida ~90 minuti) viene riusata tra una richiesta e l'altra e il login viene rifatto
 * automaticamente solo quando scade. Niente viene scritto su disco o su KV.
 * La chiave è un hash SHA-256 di utente+password+profilo: le credenziali in chiaro non sono mai una chiave.
 */
const MAX = 500;
const cache = new Map<string, ClasseVivaClient>();

export interface Creds { user: string; pass: string; ident?: string; baseUrl?: string }

export async function credsKey(c: Creds): Promise<string> {
  const data = new TextEncoder().encode(`${c.user}\u0000${c.pass}\u0000${c.ident ?? ""}\u0000${c.baseUrl ?? ""}`);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function clientFor(c: Creds): Promise<ClasseVivaClient> {
  const key = await credsKey(c);
  let client = cache.get(key);
  if (client) {
    cache.delete(key); // LRU: riporta in fondo
  } else {
    client = new ClasseVivaClient({ user: c.user, pass: c.pass, ident: c.ident || undefined, baseUrl: c.baseUrl || undefined });
  }
  cache.set(key, client);
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return client;
}

/** Inserisce in cache un client appena autenticato (es. dopo il login sulla pagina /authorize). */
export async function remember(c: Creds, client: ClasseVivaClient): Promise<void> {
  cache.set(await credsKey(c), client);
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
}
