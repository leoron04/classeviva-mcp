import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);


export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
};

const CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f3f5f9;color:#1c2333;line-height:1.45}
main{max-width:440px;margin:0 auto;padding:24px 16px 40px}
.card{background:#fff;border-radius:16px;box-shadow:0 2px 14px rgba(20,30,60,.08);padding:24px}
h1{font-size:1.35rem;margin:0 0 4px}
.sub{color:#5a6478;margin:0 0 18px;font-size:.95rem}
label{display:block;font-weight:600;font-size:.9rem;margin:14px 0 6px}
input[type=text],input[type=password]{width:100%;font-size:16px;padding:12px 14px;border:1px solid #cdd3df;border-radius:10px;background:#fbfcfe}
input:focus{outline:2px solid #2f6fed;border-color:#2f6fed}
.hint{font-size:.8rem;color:#6b7487;margin-top:4px}
button{width:100%;font-size:1rem;font-weight:600;padding:13px;border:0;border-radius:10px;margin-top:20px;cursor:pointer}
.primary{background:#2f6fed;color:#fff}
.secondary{background:transparent;color:#5a6478;margin-top:8px}
.err{background:#fdecec;color:#9b1c1c;border:1px solid #f5c2c2;padding:10px 12px;border-radius:10px;font-size:.9rem;margin-bottom:8px}
.who{background:#eef3fe;border-radius:10px;padding:10px 12px;font-size:.9rem;margin-bottom:6px}
.warn{background:#fff6e0;border:1px solid #f1d48a;border-radius:10px;padding:10px 12px;font-size:.85rem;margin-top:8px}
.notice{font-size:.8rem;color:#5a6478;margin-top:18px;border-top:1px solid #e6e9f0;padding-top:14px}
.notice p{margin:6px 0}
details summary{cursor:pointer;font-size:.9rem;color:#2f6fed;margin-top:14px}
code{background:#eef1f6;padding:2px 6px;border-radius:6px;font-size:.85em;word-break:break-all}
a{color:#2f6fed}
ol{padding-left:20px}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

const DISCLAIMER = `<div class="notice">
<p>🔒 <strong>Le tue credenziali sono cifrate.</strong> Vengono usate solo per accedere a ClasseViva al posto tuo e salvate esclusivamente dentro il token cifrato rilasciato a Claude: chi gestisce il server non può leggerle dal database. Non vengono mai scritte nei log.</p>
<p>⚠️ <strong>Progetto non ufficiale</strong>, open source, <strong>non affiliato né approvato da Gruppo Spaggiari Parma S.p.A.</strong> Usa l'API non documentata dell'app ClasseViva, in sola lettura: può smettere di funzionare in qualsiasi momento.</p>
<p>Puoi revocare l'accesso quando vuoi scollegando il connettore in Claude; cambiando la password di ClasseViva l'accesso smette subito di funzionare.</p>
</div>`;

export function loginPage(d: ConsentDescription, handle: string, opts: { error?: string; user?: string; ident?: string } = {}): string {
  const name = esc(d.clientName);
  const unverified = d.clientDomain ? `pubblicata da <strong>${esc(d.clientDomain)}</strong>` : "nome dichiarato dall'app, non verificato";
  const loopback = d.redirectIsLoopback
    ? `<div class="warn"><strong>Attenzione:</strong> l'accesso verrà inviato a un'app sul tuo computer (<code>${esc(d.redirectHost)}</code>). Continua solo se hai appena avviato tu il collegamento da quell'app.</div>`
    : "";
  return layout("Accedi con ClasseViva", `
<div class="card">
<h1>Collega ClasseViva</h1>
<p class="sub">Accedi con le stesse credenziali dell'app ClasseViva.</p>
<div class="who">L'app <strong>${name}</strong> (${unverified}) chiede di leggere il tuo registro <strong>in sola lettura</strong>. L'accesso verrà inviato a <strong>${esc(d.redirectHost)}</strong>.</div>
${loopback}
${opts.error ? `<div class="err" role="alert">${esc(opts.error)}</div>` : ""}
<form method="post" action="/authorize" autocomplete="on">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="u">Codice utente o email</label>
<input id="u" name="username" type="text" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" required maxlength="200" value="${esc(opts.user ?? "")}" placeholder="es. S1234567X">
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required maxlength="200">
<details${opts.ident ? " open" : ""}><summary>Hai più profili sullo stesso account? (opzionale)</summary>
<label for="i">Codice profilo</label>
<input id="i" name="ident" type="text" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="40" value="${esc(opts.ident ?? "")}" placeholder="es. S1234567X">
<div class="hint">Solo per account con più studenti collegati (es. genitori). Se lo lasci vuoto viene usato il primo profilo.</div>
</details>
<button class="primary" type="submit" name="decision" value="approve">Accedi e autorizza</button>
<button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Annulla</button>
</form>
${DISCLAIMER}
</div>`);
}

export function errorPage(message: string, status = 400): Response {
  return new Response(layout("Errore", `<div class="card"><h1>Qualcosa non va</h1><p>${esc(message)}</p>
<p class="sub">Torna su Claude e riprova a collegare il connettore.</p></div>`), { status, headers: SECURITY_HEADERS });
}

const REPO = "https://github.com/leoron04/classeviva-mcp";

/** Mostrata a chi prova ad accedere a un'istanza privata: spiega come crearsene una propria. */
export function privatePage(): Response {
  return new Response(layout("Istanza privata", `<div class="card"><h1>Questo server è personale</h1>
<p>Questa copia di ClasseViva MCP è riservata al suo proprietario. Puoi crearne una tua in pochi minuti, gratis, sul tuo account Cloudflare: così i tuoi dati restano solo tuoi.</p>
<ol>
<li>Crea un account gratuito su <a href="https://dash.cloudflare.com/sign-up" rel="noopener">Cloudflare</a>.</li>
<li>Segui la guida <a href="${REPO}#self-hosting" rel="noopener">Self-hosting</a> sul repository GitHub.</li>
<li>In Claude aggiungi il connettore con l'indirizzo del tuo server (<code>https://classeviva-mcp.&lt;tuo-nome&gt;.workers.dev/mcp</code>).</li>
</ol>
<p class="sub"><a href="${REPO}" rel="noopener">github.com/leoron04/classeviva-mcp</a></p></div>`), { status: 403, headers: SECURITY_HEADERS });
}

export function homePage(origin: string): Response {
  const mcp = `${origin}/mcp`;
  return new Response(layout("ClasseViva MCP", `
<div class="card">
<h1>ClasseViva MCP</h1>
<p class="sub">Collega il tuo registro elettronico ClasseViva a Claude, in sola lettura: voti e medie, compiti e verifiche, lezioni, assenze, bacheca, note.</p>
<ol>
<li>In Claude apri <strong>Impostazioni → Connettori → Aggiungi connettore personalizzato</strong>.</li>
<li>Nome: <code>ClasseViva</code> — URL: <code>${esc(mcp)}</code></li>
<li>Premi <strong>Connetti</strong> e accedi con le credenziali di ClasseViva.</li>
</ol>
${DISCLAIMER}
</div>`), { headers: SECURITY_HEADERS });
}

