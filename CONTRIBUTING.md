# Contribuire a ClasseViva MCP

Grazie per l'interesse! Questo è un progetto piccolo e personale: PR mirate e issue chiare sono le benvenute.

## Prima di aprire una PR

1. Apri un'issue (o un commento) per discutere il cambiamento, soprattutto se tocca autenticazione, cifratura o l'API Spaggiari.
2. Mantieni lo scope stretto: una feature / un fix per PR.
3. Non aggiungere dipendenze senza motivo forte.
4. **Niente credenziali** in commit, screenshot, log o issue. Usa il mock locale.

## Setup locale

```bash
npm install
cp .dev.vars.example .dev.vars
node test/mock-spaggiari.mjs &
npm run dev
npm run typecheck
CLASSEVIVA_USER=S1234567X CLASSEVIVA_PASS=prova npm run test:e2e -- http://localhost:8787
# oppure tutto insieme:
npm run test:local
```

## Stile

- TypeScript strict, ESM, niente `any` inutili.
- Tool MCP sempre in **sola lettura** (`readOnlyHint: true`).
- Messaggi utente in italiano; commenti nel codice in italiano o inglese, ma coerenti col file.
- Non esporre username, password, token o dati scolastici nei log.

## Cosa non accettaremo facilmente

- Scritture sul registro (giustificazioni, “segna come letto”, adesioni…).
- Workaround per aggirare blocchi di Spaggiari.
- Funzioni che richiedono di salvare password in chiaro sul server.

## Licenza

Contribuendo accetti che il tuo codice sia rilasciato sotto [MIT](LICENSE), copyright Leonardo Ronchi / Parallax Studios.
