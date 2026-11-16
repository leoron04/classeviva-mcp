// Test end-to-end del flusso OAuth (DCR + PKCE) contro un deploy reale.
// Uso: CLASSEVIVA_USER=... CLASSEVIVA_PASS=... node test/e2e-oauth.mjs [https://tuo-worker.workers.dev]
// Non stampa credenziali, token né dati personali: solo esiti e dimensioni.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const { CLASSEVIVA_USER: USER, CLASSEVIVA_PASS: PASS } = process.env;
if (!USER || !PASS) throw new Error("Imposta CLASSEVIVA_USER e CLASSEVIVA_PASS");

let failures = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failures++; };
const b64url = (b) => Buffer.from(b).toString("base64url");
const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const handleFrom = (html) => html.match(/name="handle" value="([^"]+)"/)?.[1];

// 1. Discovery
const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("401 senza token + WWW-Authenticate", unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get("www-authenticate") ?? ""));
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
check("protected resource metadata", prm.resource === `${BASE}/mcp`);
const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
check("authorization server metadata", asm.registration_endpoint && asm.code_challenge_methods_supported?.includes("S256"));

// 2. Dynamic client registration (come fa Claude)
const reg = await fetch(asm.registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "Claude (test)", redirect_uris: [REDIRECT, "https://claude.com/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  }),
});
const client = await reg.json();
check("DCR con redirect claude.ai + claude.com", reg.status === 201 && !!client.client_id, `status=${reg.status}`);

// 3. /authorize GET
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(12));
const authUrl = new URL(asm.authorization_endpoint);
Object.entries({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
  code_challenge_method: "S256", state, scope: "classeviva:read", resource: prm.resource,
}).forEach(([k, v]) => authUrl.searchParams.set(k, v));
const page = await fetch(authUrl, { redirect: "manual" });
const html = await page.text();
check("pagina di login (HTML, italiano, disclaimer)", page.status === 200 && /Collega ClasseViva/.test(html) && /non affiliato/.test(html),
  `frame=${page.headers.get("x-frame-options")} csp=${!!page.headers.get("content-security-policy")}`);

const post = (handle, cookie, fields, origin = BASE) => fetch(`${BASE}/authorize`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin },
  body: new URLSearchParams({ handle, decision: "approve", ...fields }),
});

// 3b. CSRF: POST senza il cookie del browser -> rifiutato
const csrf = await post(handleFrom(html), "", { username: "x", password: "y" });
check("CSRF: POST senza cookie rifiutato", csrf.status >= 400, `status=${csrf.status}`);
// 3c. CSRF: Origin diverso
const csrf2 = await post(handleFrom(html), cookiesFrom(page), { username: "x", password: "y" }, "https://evil.example");
check("CSRF: Origin estraneo rifiutato", csrf2.status === 403, `status=${csrf2.status}`);

// 4. Password sbagliata -> errore mostrato, nuovo handle
const bad = await post(handleFrom(html), cookiesFrom(page), { username: USER, password: PASS + "x-wrong" });
const badHtml = await bad.text();
check("password errata: errore in pagina", bad.status === 200 && /Credenziali ClasseViva errate/.test(badHtml));

// 5. Login corretto -> redirect a Claude con code
const ok = await post(handleFrom(badHtml), cookiesFrom(bad), { username: USER, password: PASS });
const loc = ok.headers.get("location") ?? "";
const cb = loc ? new URL(loc) : undefined;
check("login corretto: 302 verso claude.ai con code+state", ok.status === 302 && cb?.origin === "https://claude.ai" && !!cb.searchParams.get("code") && cb.searchParams.get("state") === state,
  `status=${ok.status}`);

// 6. Token (PKCE)
const tokRes = await fetch(asm.token_endpoint, {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: cb?.searchParams.get("code") ?? "", redirect_uri: REDIRECT,
    client_id: client.client_id, code_verifier: verifier, resource: prm.resource }),
});
const tok = await tokRes.json();
check("token endpoint (PKCE)", tokRes.ok && !!tok.access_token && !!tok.refresh_token, `status=${tokRes.status} expires_in=${tok.expires_in}`);
// 7. MCP con bearer
async function mcp(accessToken, label) {
  const c = new Client({ name: "e2e", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  check(`${label}: initialize`, c.getServerVersion()?.name === "classeviva");
  const { tools } = await c.listTools();
  check(`${label}: tools/list`, tools.length === 13, `${tools.length} tool`);
  for (const name of ["get_profile", "get_grades", "get_homework", "get_agenda"]) {
    const r = await c.callTool({ name, arguments: {} });
    const text = r.content?.[0]?.text ?? "";
    check(`${label}: ${name}`, !r.isError && text.length > 10, `${text.length} byte`);
  }
  // get_file: in locale (mock) prova i quattro casi; contro un deploy reale solo se E2E_FILES=1 e sono date le coordinate
  if (process.env.E2E_MOCK_FILES) {
    const cases = [
      ["didattica PDF", { tipo: "didattica", id: "501" }, (j) => j.tipo === "PDF" && j.pagine_totali === 2 && /--- Pagina 2 ---\nEsercizio due/.test(j.contenuto)],
      ["didattica PDF pagina 2", { tipo: "didattica", id: "501", pagina: 2 }, (j) => j.da_pagina === 2 && !/Pagina 1/.test(j.contenuto)],
      ["didattica link Google", { tipo: "didattica", id: "502" }, (j) => j.link?.startsWith("https://docs.google.com/") && /Google/.test(j.nota)],
      ["bacheca docx", { tipo: "bacheca", id: "CF/1", allegato: 1 }, (j) => j.nome === "circ12.docx" && j.contenuto === "Sciopero del 20 novembre & uscita\nSeconda riga"],
      ["compito txt", { tipo: "compito", id: "NEWDC/125021", allegato: "77" }, (j) => /Traccia/.test(j.contenuto)],
    ];
    for (const [name, args, test] of cases) {
      const r = await c.callTool({ name: "get_file", arguments: args });
      let j; try { j = JSON.parse(r.content?.[0]?.text ?? ""); } catch { j = {}; }
      check(`${label}: get_file ${name}`, !r.isError && test(j), r.isError ? r.content?.[0]?.text : "");
    }
    const miss = await c.callTool({ name: "get_file", arguments: { tipo: "bacheca", id: "CF/1", allegato: 9 } });
    check(`${label}: get_file allegato inesistente -> errore in italiano`, miss.isError && /File non trovato/.test(miss.content?.[0]?.text ?? ""));
    const bad = await c.callTool({ name: "get_file", arguments: { tipo: "bacheca", id: "../x" } });
    check(`${label}: get_file id non valido rifiutato`, bad.isError && /CODICE\/NUMERO/.test(bad.content?.[0]?.text ?? ""));
    const did = JSON.parse((await c.callTool({ name: "get_didactics", arguments: {} })).content[0].text);
    check(`${label}: get_didactics espone id`, did[0]?.cartelle?.[0]?.contenuti?.[0]?.id === 501);
    const hw = JSON.parse((await c.callTool({ name: "get_homework", arguments: {} })).content[0].text);
    check(`${label}: get_homework espone id e file`, hw.compiti?.[0]?.id === "NEWDC/125021" && hw.compiti[0].file?.[0]?.id === 77);
  }
  await c.close();
}
await mcp(tok.access_token, "bearer");

// 8. Refresh token
const refRes = await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }) });
const ref = await refRes.json();
check("refresh token", refRes.ok && !!ref.access_token);
if (ref.access_token) await mcp(ref.access_token, "dopo refresh");

// 9. Token falso
const fake = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer a:b:c" }, body: "{}" });
check("token falso rifiutato", fake.status === 401);

// 10. Replay del code (dopo i test MCP: invalida il grant). E2E_KEEP_GRANT=1 per saltarlo.
if (!process.env.E2E_KEEP_GRANT) {
const badPkce = await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: cb?.searchParams.get("code") ?? "", redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: "x".repeat(43) }) });
check("code riusato rifiutato", badPkce.status === 400);
const afterReplay = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ref.access_token}` }, body: "{}" });
check("riuso del code revoca il grant (token non più validi)", afterReplay.status === 401);


}
console.log(failures ? `\n${failures} test FALLITI` : "\nTutti i test OK");
process.exit(failures ? 1 : 0);
