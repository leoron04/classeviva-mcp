# Security Policy

## Versioni supportate

Solo l'ultima versione su `main` (deploy Cloudflare Workers) riceve fix di sicurezza.

## Cosa segnalare

- Esposizione di credenziali ClasseViva o di token OAuth
- Bypass di CSRF / rate limit sulla pagina `/authorize`
- Accesso ai dati di un utente tramite il token di un altro
- XSS sulla pagina di login o open redirect OAuth
- Qualsiasi modo di leggere le props cifrate del grant senza un token valido

**Non** sono vulnerabilità: l'uso dell'API non ufficiale Spaggiari, il fatto che il server debba conoscere la password per parlare con ClasseViva (limite del protocollo), o un deploy self-hosted mal configurato.

## Come segnalare

Usa le **[GitHub Private Vulnerability Advisories](https://github.com/leoron04/classeviva-mcp/security/advisories/new)** di questo repository.

Includi: descrizione, passi per riprodurre, impatto stimato, e se possibile una PoC minima **senza** credenziali reali.

Evita di aprire issue pubbliche con dettagli sfruttabili. Non inviare password di ClasseViva.

Cerchiamo di rispondere entro pochi giorni. Grazie per aver segnalato in modo responsabile.
