/**
 * Conteggio delle ore di assenza rispetto al limite per la validità dell'anno (DPR 122/2009 art. 14 c. 7:
 * frequenza di almeno 3/4 del monte ore annuale personalizzato → limite predefinito 25%).
 * Modulo senza dipendenze (testabile con `node --experimental-strip-types`).
 *
 * Dati ClasseViva usati:
 *  - assenze (absences/details): ABA0 assenza giornaliera, ABR0 ritardo, ABR1 ritardo breve, ABU0 uscita anticipata.
 *    Per ritardi/uscite `evtValue` = ore di assenza (quando il registro lo indica).
 *  - lezioni registrate (lessons): ore effettivamente tenute in classe → ore di un giorno di assenza e orario settimanale.
 *  - calendario (calendar/all): giorni di lezione "SD" per la proiezione a fine anno.
 */
export interface AbsenceEvent { evtCode: string; evtDate: string; evtHPos?: number | null; evtValue?: number | null; isJustified?: boolean }
export interface LessonEvent { evtDate: string; evtHPos: number; evtDuration?: number | null }
export interface CalendarDay { dayDate: string; dayStatus: string }

export interface AttendanceOptions {
  today: string;
  /** Ore settimanali dell'orario (se manca: stimate dalle lezioni registrate). */
  oreSettimanali?: number;
  /** Monte ore annuo (se manca: ore settimanali × settimane). */
  monteOre?: number;
  /** Settimane di lezione dell'anno (default 33, come da normativa). */
  settimane?: number;
  /** Percentuale massima di assenze (default 25). */
  percentuale?: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Slot orari distinti di lezione registrati per ogni giorno. */
export function hoursByDay(lessons: LessonEvent[]): Map<string, number> {
  const slots = new Map<string, Set<number>>();
  for (const l of lessons) {
    if (!l?.evtDate || typeof l.evtHPos !== "number") continue;
    const s = slots.get(l.evtDate) ?? new Set<number>();
    for (let h = l.evtHPos; h < l.evtHPos + Math.max(1, Number(l.evtDuration) || 1); h++) s.add(h);
    slots.set(l.evtDate, s);
  }
  return new Map([...slots].map(([d, s]) => [d, s.size]));
}

const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** Ore tipiche per giorno della settimana (moda delle lezioni registrate). */
export function typicalWeek(byDay: Map<string, number>): Map<number, number> {
  const per = new Map<number, Map<number, number>>();
  for (const [d, n] of byDay) {
    const w = weekday(d);
    const m = per.get(w) ?? new Map<number, number>();
    m.set(n, (m.get(n) ?? 0) + 1);
    per.set(w, m);
  }
  const out = new Map<number, number>();
  for (const [w, m] of per) {
    const [best] = [...m].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    if (best) out.set(w, best[0]);
  }
  return out;
}

export function computeAttendance(events: AbsenceEvent[], lessons: LessonEvent[], calendar: CalendarDay[], o: AttendanceOptions) {
  const byDay = hoursByDay(lessons);
  const week = typicalWeek(byDay);
  const estimatedWeekly = [...week.values()].reduce((a, b) => a + b, 0);
  const weekly = o.oreSettimanali ?? (estimatedWeekly || undefined);
  const settimane = o.settimane ?? 33;
  const perc = o.percentuale ?? 25;
  const monte = o.monteOre ?? (weekly ? weekly * settimane : undefined);
  const dayHours = (d: string) => byDay.get(d) || week.get(weekday(d)) || (weekly ? weekly / Math.max(1, week.size || 5) : 0);

  const det = {
    assenze: { numero: 0, ore: 0 },
    ritardi: { numero: 0, ore: 0, senza_ore_indicate: 0 },
    ritardi_brevi: { numero: 0 },
    uscite_anticipate: { numero: 0, ore: 0, senza_ore_indicate: 0 },
  };
  for (const e of events) {
    const v = typeof e.evtValue === "number" && e.evtValue > 0 ? e.evtValue : undefined;
    switch (e.evtCode) {
      case "ABA0": det.assenze.numero++; det.assenze.ore += dayHours(e.evtDate); break;
      case "ABR0": det.ritardi.numero++; if (v) det.ritardi.ore += v; else det.ritardi.senza_ore_indicate++; break;
      case "ABR1": det.ritardi_brevi.numero++; break;
      case "ABU0": det.uscite_anticipate.numero++; if (v) det.uscite_anticipate.ore += v; else det.uscite_anticipate.senza_ore_indicate++; break;
    }
  }
  const sure = det.assenze.ore + det.ritardi.ore + det.uscite_anticipate.ore;
  const uncertain = det.ritardi.senza_ore_indicate + det.uscite_anticipate.senza_ore_indicate; // al massimo 1 ora ciascuno
  const limite = monte ? Math.floor((monte * perc) / 100) : undefined;

  // proiezione: ritmo attuale sui giorni di lezione già fatti → giorni di lezione dell'anno
  const sd = calendar.filter((d) => d.dayStatus === "SD");
  const done = sd.filter((d) => d.dayDate <= o.today).length;
  const total = sd.length;
  const projection = done > 0 && total > done ? round1((sure / done) * total) : undefined;

  const pct = (h: number) => (monte ? round1((h / monte) * 100) : undefined);
  return {
    ore_settimanali: weekly, ore_settimanali_stimate: o.oreSettimanali ? undefined : estimatedWeekly || undefined,
    settimane, monte_ore_annuo: monte, limite_percentuale: perc, limite_ore: limite,
    ore_assenza: round1(sure), ore_assenza_max: uncertain ? round1(sure + uncertain) : undefined,
    percentuale_assenze: pct(sure),
    ore_ancora_disponibili: limite !== undefined ? Math.max(0, round1(limite - sure - uncertain)) : undefined,
    giorni_di_lezione: total ? { fatti: done, totali: total } : undefined,
    proiezione_fine_anno: projection !== undefined ? { ore: projection, percentuale: pct(projection) } : undefined,
    stato: limite === undefined ? "monte ore sconosciuto: indica ore_settimanali o monte_ore"
      : sure + uncertain > limite ? "LIMITE SUPERATO"
      : (projection ?? 0) > limite ? "attenzione: al ritmo attuale supereresti il limite"
      : sure + uncertain > limite * 0.75 ? "attenzione: oltre il 75% del limite" : "ok",
    dettaglio: det,
  };
}
