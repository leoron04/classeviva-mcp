// Finto server Spaggiari per lo sviluppo locale senza credenziali vere (porta 9999).
// Accetta qualsiasi password, tranne quelle che contengono "wrong" (risponde 422).
import http from "node:http";
const T = new Date().toISOString().slice(0, 10);
const data = {
  card: { card: { firstName: "MARIO", lastName: "ROSSI", birthDate: "2011-01-01", schName: "LICEO SCIENTIFICO", schDedication: "G. GALILEI", schCity: "ROMA", schProv: "RM", miurSchoolCode: "RMPS000000", usrType: "S" } },
  grades: { grades: [
    { evtDate: T, evtCode: "GRV0", subjectDesc: "MATEMATICA", displayValue: "7+", decimalValue: 7.25, color: "green", canceled: false, periodPos: 1, periodDesc: "Trimestre", teacherName: "BIANCHI", weightFactor: 1, notesForFamily: "" },
    { evtDate: T, evtCode: "GRV1", subjectDesc: "MATEMATICA", displayValue: "5", decimalValue: 5, color: "red", canceled: false, periodPos: 1, periodDesc: "Trimestre", teacherName: "BIANCHI", weightFactor: 1 },
    { evtDate: T, evtCode: "GRV1", subjectDesc: "LATINO", displayValue: "8", decimalValue: 8, color: "blue", canceled: false, periodPos: 1, periodDesc: "Trimestre", teacherName: "VERDI", weightFactor: 1 } ] },
  agenda: { agenda: [{ evtCode: "AGNT", evtDatetimeBegin: `${T}T09:00:00+01:00`, evtDatetimeEnd: `${T}T10:00:00+01:00`, isFullDay: false, notes: "Verifica equazioni", authorName: "BIANCHI", subjectDesc: "MATEMATICA" }] },
  lessons: { lessons: [{ evtDate: T, evtHPos: 1, evtDuration: 1, subjectDesc: "LATINO", authorName: "VERDI", lessonType: "Lezione", lessonArg: "Ablativo assoluto" }] },
  absences: { events: [{ evtDate: T, evtCode: "ABR0", evtHPos: 2, isJustified: false }] },
  noticeboard: { items: [{ pubDT: `${T}T08:00:00+01:00`, cntTitle: "Circ. 12 - Sciopero", cntCategory: "Circolari", readStatus: false, attachments: [{ fileName: "circ12.pdf" }], evtCode: "CF", pubId: 1 }] },
  notes: { NTTE: [], NTCL: [{ evtDate: T, authorName: "NERI", evtText: "Disturba la lezione", readStatus: true }], NTWN: [], NTST: [] },
  subjects: { subjects: [{ id: 1, description: "MATEMATICA", teachers: [{ teacherName: "BIANCHI" }] }] },
  periods: { periods: [{ periodPos: 1, periodDesc: "Trimestre", dateStart: "2026-09-14", dateEnd: "2026-12-22", isFinal: false }] },
  didactics: { didacticts: [{ teacherName: "VERDI", folders: [{ folderName: "Esercizi", lastShareDT: T, contents: [{ contentName: "es1.pdf", objectType: "file", shareDT: T }] }] }] },
  calendar: { calendar: [{ dayDate: T, dayStatus: "SD" }, { dayDate: "2026-12-08", dayStatus: "HD" }] },
};
let logins = 0;
http.createServer((req, res) => {
  const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.url.endsWith("/auth/login")) {
    let body = ""; req.on("data", (c) => (body += c));
    return req.on("end", () => {
      logins++;
      if (JSON.parse(body || "{}").pass?.includes("wrong")) return send(422, { error: "422 - authentication failed", info: "AuthFailed" });
      send(200, { ident: "S1234567X", token: "tok", firstName: "MARIO", lastName: "ROSSI", release: new Date().toISOString(), expire: new Date(Date.now() + 5400e3).toISOString() });
    });
  }
  if (req.headers["z-auth-token"] !== "tok") return send(401, { error: "auth" });
  const m = req.url.match(/\/students\/1234567\/([a-z]+)/);
  if (!m) return send(404, { error: "102:CvvRestApi/wrong uri" });
  const key = m[1] === "absences" ? "absences" : m[1];
  if (data[key]) return send(200, data[key]);
  send(404, { error: "nope" });
}).listen(9999, () => console.log("mock on 9999"));
process.on("SIGTERM", () => { console.log("logins:", logins); process.exit(0); });
