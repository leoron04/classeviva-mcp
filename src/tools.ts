import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClasseVivaClient, ClasseVivaError } from "./classeviva.js";
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, readClasseVivaFile } from "./files.js";
import { addDays, isIsoDate, maxDate, minDate, schoolYearStart, toApi, todayRome } from "./dates.js";

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data: YYYY-MM-DD");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
}
function fail(e: unknown) {
  const msg = e instanceof ClasseVivaError || e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: `Errore: ${msg}` }] };
}
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};

const GRADE_KIND: Record<string, string> = { GRV0: "scritto", GRV1: "orale", GRV2: "pratico" };
const AGENDA_KIND: Record<string, string> = { AGNT: "evento in agenda", AGHW: "compiti", AGCR: "attività di classe" };
const ABSENCE_KIND: Record<string, string> = { ABA0: "assenza", ABR0: "ritardo", ABR1: "ritardo breve", ABU0: "uscita anticipata" };
const DIDACTIC_KIND: Record<string, string> = { file: "file", link: "link", text: "testo" };
const NOTE_KIND: Record<string, string> = { NTTE: "annotazione del docente", NTCL: "nota disciplinare", NTWN: "richiamo", NTST: "sanzione disciplinare" };

const round2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const time = (dt?: string) => (dt ? dt.slice(11, 16) : undefined);

async function fetchHomework(c: ClasseVivaClient) {
  const { items } = await c.student<{ items: any[] }>("homeworks");
  return (items ?? []).map((h) => ({
    assegnato: h.assignmentDate, consegna: h.expiryDate ?? h.assignmentDate,
    materia: h.subjectDesc || undefined, docente: h.teacherName, testo: h.homeworkDesc,
    fatto: Boolean(h.homeworkDone || h.homeworkMarkedDone),
    id: h.evtCode && h.evtId != null ? `${h.evtCode}/${h.evtId}` : undefined,
    file: h.teacherFiles?.length ? h.teacherFiles.map((f: any) => ({
      nome: f.fileName ?? f.name ?? f.filename ?? f.title, id: f.fileId ?? f.id ?? f.attachId,
    })) : undefined,
    link: h.teacherLinks?.length ? h.teacherLinks.map((l: any) => (typeof l === "string" ? l : l.link ?? l.url ?? l.href ?? l)) : undefined,
  })).sort((a, b) => String(a.consegna).localeCompare(String(b.consegna)));
}

export function registerTools(server: McpServer, getClient: () => ClasseVivaClient) {
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool("get_profile", {
    title: "Profilo studente",
    description: "Nome dello studente, scuola, classe. Utile come primo controllo che il login funzioni.",
    inputSchema: {}, annotations: ro,
  }, wrap(async () => {
    const { card: c } = await getClient().student("card");
    return {
      nome: c.firstName, cognome: c.lastName, data_nascita: c.birthDate,
      scuola: [c.schName, c.schDedication].filter(Boolean).join(" "), citta: c.schCity, provincia: c.schProv,
      codice_scuola: c.miurSchoolCode, tipo_utente: c.usrType,
    };
  }));

  server.registerTool("get_grades", {
    title: "Voti",
    description: "Voti dell'anno scolastico corrente, con medie per materia e generale. I voti 'blu' (non fanno media) e annullati sono esclusi dalle medie. Filtri opzionali per materia (testo parziale) e periodo (numero, es. 1 = primo quadrimestre).",
    inputSchema: {
      materia: z.string().optional().describe("Filtro per nome materia, es. 'mate'"),
      periodo: z.number().int().optional().describe("Numero del periodo (periodPos), es. 1 o 2"),
      ultimi: z.number().int().positive().optional().describe("Mostra solo gli ultimi N voti"),
    },
    annotations: ro,
  }, wrap(async ({ materia, periodo, ultimi }) => {
    const { grades } = await getClient().student<{ grades: any[] }>("grades");
    let list = grades;
    if (materia) list = list.filter((g) => String(g.subjectDesc).toLowerCase().includes(materia.toLowerCase()));
    if (periodo) list = list.filter((g) => g.periodPos === periodo);
    list = [...list].sort((a, b) => String(b.evtDate).localeCompare(String(a.evtDate)));

    const counts = (g: any) => !g.canceled && g.color !== "blue" && typeof g.decimalValue === "number";
    const bySubject: Record<string, number[]> = {};
    for (const g of list) if (counts(g)) (bySubject[g.subjectDesc] ??= []).push(g.decimalValue);
    const medie = Object.fromEntries(Object.entries(bySubject).sort().map(([k, v]) => [k, { media: avg(v), n_voti: v.length }]));
    const subjAvgs = Object.values(medie).map((m) => m.media!).filter((x) => x != null);

    if (ultimi) list = list.slice(0, ultimi);
    return {
      totale_voti: list.length,
      media_generale_delle_materie: avg(subjAvgs),
      medie_per_materia: medie,
      voti: list.map((g) => ({
        data: g.evtDate, materia: g.subjectDesc, voto: g.displayValue, valore: g.decimalValue,
        tipo: GRADE_KIND[g.evtCode] ?? g.componentDesc ?? g.evtCode, periodo: g.periodDesc,
        docente: g.teacherName, commento: g.notesForFamily || undefined,
        non_fa_media: g.color === "blue" || undefined, annullato: g.canceled || undefined,
        peso: g.weightFactor !== 1 ? g.weightFactor : undefined,
      })),
    };
  }));

  server.registerTool("get_agenda", {
    title: "Agenda (compiti e verifiche)",
    description: "Eventi in agenda (verifiche, interrogazioni, attività) più i compiti in scadenza in un intervallo di date. Default: da oggi ai prossimi 14 giorni. Accetta date future.",
    inputSchema: {
      dal: dateArg.optional().describe("Data inizio YYYY-MM-DD (default oggi)"),
      al: dateArg.optional().describe("Data fine YYYY-MM-DD (default oggi + 14 giorni)"),
    },
    annotations: ro,
  }, wrap(async ({ dal, al }) => {
    const from = dal ?? todayRome();
    const to = al ?? addDays(from, 14);
    const { agenda } = await getClient().student<{ agenda: any[] }>(`agenda/all/${toApi(from)}/${toApi(to)}`);
    const items = [...agenda].sort((a, b) => String(a.evtDatetimeBegin).localeCompare(String(b.evtDatetimeBegin)));
    const hw = (await fetchHomework(getClient())).filter((h) => h.consegna >= from && h.consegna <= to);
    return {
      dal: from, al: to, totale_eventi: items.length, totale_compiti: hw.length,
      eventi: items.map((e) => ({
        data: String(e.evtDatetimeBegin).slice(0, 10),
        ora: e.isFullDay ? "tutto il giorno" : `${time(e.evtDatetimeBegin)}-${time(e.evtDatetimeEnd)}`,
        tipo: AGENDA_KIND[e.evtCode] ?? e.evtCode, materia: e.subjectDesc || undefined,
        docente: e.authorName, testo: e.notes,
      })),
      compiti_in_scadenza: hw,
      nota: "I compiti assegnati dai docenti arrivano dalla sezione Compiti di ClasseViva (non dall'agenda), ordinati per data di consegna.",
    };
  }));

  server.registerTool("get_homework", {
    title: "Compiti assegnati",
    description: "Compiti assegnati dai docenti (sezione Compiti/Didattica di ClasseViva), filtrati per data di consegna. Default: consegna da oggi ai prossimi 14 giorni. Usa questo per sapere cosa c'è da fare. Se un compito ha `file`, leggili con get_file (tipo 'compito', id del compito, allegato = id del file).",
    inputSchema: {
      dal: dateArg.optional().describe("Consegna dal YYYY-MM-DD (default oggi)"),
      al: dateArg.optional().describe("Consegna fino al YYYY-MM-DD (default oggi + 14 giorni)"),
      materia: z.string().optional().describe("Filtro per nome materia (testo parziale)"),
      includi_fatti: z.boolean().optional().describe("Includi anche quelli segnati come fatti (default true)"),
    },
    annotations: ro,
  }, wrap(async ({ dal, al, materia, includi_fatti }) => {
    const from = dal ?? todayRome();
    const to = al ?? addDays(from, 14);
    const m = materia?.toLowerCase();
    const list = (await fetchHomework(getClient())).filter((h) =>
      h.consegna >= from && h.consegna <= to &&
      (!m || String(h.materia ?? "").toLowerCase().includes(m)) &&
      (includi_fatti !== false || !h.fatto));
    return { dal: from, al: to, totale: list.length, compiti: list };
  }));

  server.registerTool("get_lessons", {
    title: "Argomenti delle lezioni",
    description: "Argomenti spiegati a lezione (registro di classe) in un intervallo di date. Default: ultimi 7 giorni. La data fine non può superare oggi.",
    inputSchema: {
      dal: dateArg.optional(), al: dateArg.optional(),
      materia: z.string().optional().describe("Filtro per nome materia (testo parziale)"),
    },
    annotations: ro,
  }, wrap(async ({ dal, al, materia }) => {
    const today = todayRome();
    const to = minDate(al ?? today, today);
    const from = maxDate(dal ?? addDays(to, -7), schoolYearStart(today));
    const { lessons } = await getClient().student<{ lessons: any[] }>(`lessons/${toApi(from)}/${toApi(to)}`);
    let list = lessons;
    if (materia) list = list.filter((l) => String(l.subjectDesc).toLowerCase().includes(materia.toLowerCase()));
    list = [...list].sort((a, b) => `${a.evtDate}${String(a.evtHPos).padStart(2, "0")}`.localeCompare(`${b.evtDate}${String(b.evtHPos).padStart(2, "0")}`));
    return {
      dal: from, al: to, totale: list.length,
      lezioni: list.map((l) => ({
        data: l.evtDate, ora: l.evtHPos, durata_ore: l.evtDuration, materia: l.subjectDesc,
        docente: l.authorName, tipo: l.lessonType, argomento: l.lessonArg || undefined,
      })),
    };
  }));

  server.registerTool("get_absences", {
    title: "Assenze, ritardi, uscite",
    description: "Assenze, ritardi e uscite anticipate dell'anno corrente, con totali e quelle da giustificare. Date opzionali (fine massimo oggi).",
    inputSchema: { dal: dateArg.optional(), al: dateArg.optional() },
    annotations: ro,
  }, wrap(async ({ dal, al }) => {
    const today = todayRome();
    let path = "absences/details";
    if (dal || al) {
      const from = maxDate(dal ?? schoolYearStart(today), schoolYearStart(today));
      const to = minDate(al ?? today, today);
      path += `/${toApi(from)}/${toApi(to)}`;
    }
    const { events } = await getClient().student<{ events: any[] }>(path);
    const list = [...events].sort((a, b) => String(b.evtDate).localeCompare(String(a.evtDate)));
    const totali: Record<string, number> = {};
    for (const e of list) { const k = ABSENCE_KIND[e.evtCode] ?? e.evtCode; totali[k] = (totali[k] ?? 0) + 1; }
    return {
      totali, da_giustificare: list.filter((e) => !e.isJustified).length,
      eventi: list.map((e) => ({
        data: e.evtDate, tipo: ABSENCE_KIND[e.evtCode] ?? e.evtCode, ora: e.evtHPos ?? undefined,
        giustificata: !!e.isJustified, motivo: e.justifReasonDesc || undefined,
      })),
    };
  }));

  server.registerTool("get_noticeboard", {
    title: "Bacheca (circolari)",
    description: "Circolari e comunicazioni della bacheca, dalla più recente. Sola lettura: non segna nulla come letto. Per leggere un allegato usa get_file con tipo 'bacheca', id della circolare e numero dell'allegato.",
    inputSchema: {
      limite: z.number().int().positive().max(200).optional().describe("Numero massimo (default 30)"),
      solo_non_lette: z.boolean().optional(),
      cerca: z.string().optional().describe("Filtro sul titolo"),
    },
    annotations: ro,
  }, wrap(async ({ limite, solo_non_lette, cerca }) => {
    const { items } = await getClient().student<{ items: any[] }>("noticeboard");
    let list = [...items].sort((a, b) => String(b.pubDT).localeCompare(String(a.pubDT)));
    if (solo_non_lette) list = list.filter((i) => !i.readStatus);
    if (cerca) list = list.filter((i) => String(i.cntTitle).toLowerCase().includes(cerca.toLowerCase()));
    const total = list.length;
    list = list.slice(0, limite ?? 30);
    return {
      totale: total, mostrate: list.length,
      circolari: list.map((i) => ({
        pubblicata: String(i.pubDT).slice(0, 10), titolo: i.cntTitle, categoria: i.cntCategory,
        letta: !!i.readStatus, valida_fino: i.cntValidTo,
        allegati: (i.attachments ?? []).map((a: any) => ({ nome: a.fileName, numero: a.attachNum })),
        richiede_adesione: i.needJoin || undefined, richiede_risposta: i.needReply || undefined,
        id: `${i.evtCode}/${i.pubId}`,
      })),
    };
  }));

  server.registerTool("get_notes", {
    title: "Note disciplinari e annotazioni",
    description: "Note disciplinari, annotazioni dei docenti, richiami e sanzioni.",
    inputSchema: {}, annotations: ro,
  }, wrap(async () => {
    const data = await getClient().student<Record<string, any[]>>("notes/all");
    const out: any[] = [];
    for (const [k, arr] of Object.entries(data)) {
      if (!Array.isArray(arr)) continue;
      for (const n of arr) out.push({
        data: n.evtDate, tipo: NOTE_KIND[k] ?? k, docente: n.authorName,
        testo: n.evtText || (n.readStatus === false ? "(testo non ancora letto: aprila nell'app per vederlo)" : undefined),
        categoria_richiamo: n.warningType || undefined,
      });
    }
    out.sort((a, b) => String(b.data).localeCompare(String(a.data)));
    return { totale: out.length, note: out };
  }));

  server.registerTool("get_subjects", {
    title: "Materie e docenti",
    description: "Elenco delle materie con i relativi docenti e id materia.",
    inputSchema: {}, annotations: ro,
  }, wrap(async () => {
    const { subjects } = await getClient().student<{ subjects: any[] }>("subjects");
    return subjects.map((s) => ({ id: s.id, materia: s.description, docenti: (s.teachers ?? []).map((t: any) => t.teacherName) }));
  }));

  server.registerTool("get_periods", {
    title: "Periodi (quadrimestri/trimestri)",
    description: "Periodi dell'anno scolastico con date di inizio e fine.",
    inputSchema: {}, annotations: ro,
  }, wrap(async () => {
    const { periods } = await getClient().student<{ periods: any[] }>("periods");
    return periods.map((p) => ({ numero: p.periodPos, nome: p.periodDesc, inizio: p.dateStart, fine: p.dateEnd, finale: !!p.isFinal }));
  }));

  server.registerTool("get_didactics", {
    title: "Didattica (materiali dei docenti)",
    description: "Materiali condivisi dai docenti nella sezione Didattica, per docente e cartella. Per leggerne il contenuto usa get_file con tipo 'didattica' e l'`id` del contenuto.",
    inputSchema: {}, annotations: ro,
  }, wrap(async () => {
    const data = await getClient().student<any>("didactics");
    const teachers: any[] = data.didacticts ?? data.didactics ?? [];
    return teachers.map((t) => ({
      docente: t.teacherName,
      cartelle: (t.folders ?? []).map((f: any) => ({
        cartella: f.folderName, ultima_condivisione: f.lastShareDT,
        contenuti: (f.contents ?? []).map((c: any) => ({
          id: c.contentId, nome: c.contentName || "(senza titolo: il nome del file arriva con get_file)",
          tipo: DIDACTIC_KIND[c.objectType] ?? c.objectType, condiviso: c.shareDT,
        })),
      })),
    }));
  }));

  server.registerTool("get_file", {
    title: "Leggi un file di ClasseViva",
    description:
      "Legge il contenuto di un file allegato su ClasseViva: materiali della Didattica (tipo 'didattica', id da get_didactics), " +
      "allegati delle circolari in Bacheca (tipo 'bacheca', id CODICE/NUMERO da get_noticeboard + numero dell'allegato) e file dei docenti nei Compiti " +
      "(tipo 'compito', id da get_homework + id del file). Legge PDF con testo (pagina per pagina), Word .docx, PowerPoint .pptx, OpenDocument e file di testo; " +
      "per i link restituisce l'URL. I testi lunghi sono divisi: per i PDF usa `pagina` per continuare, per gli altri `offset`. " +
      "Immagini, vecchi .doc/.ppt, Excel e PDF scansionati non sono leggibili (restituisce nome e tipo). Limite 20 MB.",
    inputSchema: {
      tipo: z.enum(["didattica", "bacheca", "compito"]).describe("Da dove viene il file"),
      id: z.string().min(1).describe("didattica: id del contenuto (es. 58386084); bacheca: id della circolare (es. CF/123456); compito: id del compito (es. NEWDC/125021)"),
      allegato: z.union([z.string(), z.number()]).optional().describe("bacheca: numero dell'allegato (default 1); compito: id del file del docente"),
      pagina: z.number().int().positive().optional().describe("Solo PDF: pagina da cui iniziare (default 1)"),
      offset: z.number().int().min(0).optional().describe("Documenti e testi: carattere da cui iniziare (default 0)"),
      max_caratteri: z.number().int().min(1000).max(HARD_MAX_CHARS).optional().describe(`Massimo di caratteri restituiti (default ${DEFAULT_MAX_CHARS})`),
    },
    annotations: ro,
  }, wrap(async (args) => readClasseVivaFile(getClient(), args)));

  server.registerTool("get_calendar", {
    title: "Calendario scolastico",
    description: "Giorni di scuola, festività e vacanze in un intervallo (default: prossimi 30 giorni). Restituisce solo i giorni NON di lezione, più il conteggio dei giorni di scuola.",
    inputSchema: { dal: dateArg.optional(), al: dateArg.optional() },
    annotations: ro,
  }, wrap(async ({ dal, al }) => {
    const from = dal ?? todayRome();
    const to = al ?? addDays(from, 30);
    const { calendar } = await getClient().student<{ calendar: any[] }>("calendar/all");
    const days = calendar.filter((d) => d.dayDate >= from && d.dayDate <= to);
    const STATUS: Record<string, string> = { SD: "lezione", HD: "vacanza/festività", NW: "non lavorativo", US: "sospensione" };
    return {
      dal: from, al: to,
      giorni_di_lezione: days.filter((d) => d.dayStatus === "SD").length,
      giorni_senza_lezione: days.filter((d) => d.dayStatus !== "SD").map((d) => ({ data: d.dayDate, stato: STATUS[d.dayStatus] ?? d.dayStatus })),
    };
  }));
}

export { isIsoDate };
