// node --experimental-strip-types test/unit-attendance.mjs
import { computeAttendance, hoursByDay, typicalWeek } from "../src/attendance.ts";
let fail = 0;
const check = (c, l, x = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${l} ${x}`); if (!c) fail++; };
// settimana tipo: lun 5, mar 6, mer 5, gio 6, ven 5 = 27 ore (due settimane registrate)
const days = { "2026-11-02": 5, "2026-11-03": 6, "2026-11-04": 5, "2026-11-05": 6, "2026-11-06": 5, "2026-11-09": 5, "2026-11-10": 6, "2026-11-11": 5, "2026-11-12": 4, "2026-11-13": 5 };
const lessons = Object.entries(days).flatMap(([d, n]) => Array.from({ length: n }, (_, i) => ({ evtDate: d, evtHPos: i + 1, evtDuration: 1 })));
lessons.push({ evtDate: "2026-11-02", evtHPos: 1, evtDuration: 1 }); // compresenza: stessa ora, non va contata due volte
check(hoursByDay(lessons).get("2026-11-02") === 5, "compresenze contate una volta");
check([...typicalWeek(hoursByDay(lessons)).values()].reduce((a, b) => a + b, 0) === 27, "orario settimanale stimato 27 h");
const events = [
  { evtCode: "ABA0", evtDate: "2026-11-03" },            // martedì registrato: 6 h
  { evtCode: "ABA0", evtDate: "2026-11-17" },            // martedì senza lezioni registrate: ora tipica 6 h
  { evtCode: "ABR0", evtDate: "2026-11-04", evtHPos: 1, evtValue: 2 },
  { evtCode: "ABR0", evtDate: "2026-11-05", evtHPos: 1, evtValue: null },
  { evtCode: "ABR1", evtDate: "2026-11-06" },
  { evtCode: "ABU0", evtDate: "2026-11-09", evtHPos: 5, evtValue: 1 },
];
const cal = Array.from({ length: 200 }, (_, i) => ({ dayDate: new Date(Date.UTC(2026, 8, 14 + i)).toISOString().slice(0, 10), dayStatus: i % 7 >= 5 ? "HD" : "SD" }));
const r = computeAttendance(events, lessons, cal, { today: "2026-11-17" });
check(r.monte_ore_annuo === 891 && r.limite_ore === 222, "monte ore 27×33 = 891, limite 25% = 222", JSON.stringify([r.monte_ore_annuo, r.limite_ore]));
check(r.ore_assenza === 15 && r.ore_assenza_max === 16, "ore: 6+6+2+1 = 15 certe, +1 incerta", JSON.stringify([r.ore_assenza, r.ore_assenza_max]));
check(r.dettaglio.ritardi_brevi.numero === 1 && r.dettaglio.ritardi.senza_ore_indicate === 1, "ritardi brevi non contati, ritardo senza ore segnalato");
check(r.stato === "ok" && r.proiezione_fine_anno?.ore > 15, "stato e proiezione", JSON.stringify(r.proiezione_fine_anno));
const r2 = computeAttendance(events, lessons, cal, { today: "2026-11-17", oreSettimanali: 30, percentuale: 20 });
check(r2.monte_ore_annuo === 990 && r2.limite_ore === 198, "parametri: 30 h/sett., limite 20%");
const r3 = computeAttendance(events, lessons, cal, { today: "2026-11-17", monteOre: 50 });
check(r3.stato === "LIMITE SUPERATO" && r3.ore_ancora_disponibili === 0, "monte ore esplicito e limite superato");
const r4 = computeAttendance([], [], [], { today: "2026-11-17" });
check(r4.limite_ore === undefined && /sconosciuto/.test(r4.stato), "senza dati: chiede l'orario");
console.log(fail ? `\n${fail} falliti` : "\nTutti i test OK");
process.exit(fail ? 1 : 0);
