// Finto server Spaggiari per lo sviluppo locale senza credenziali vere (porta 9999).
// Accetta qualsiasi password, tranne quelle che contengono "wrong" (risponde 422).
import http from "node:http";
import zlib from "node:zlib";
const T = new Date().toISOString().slice(0, 10);
const data = {
  card: { card: { firstName: "MARIO", lastName: "ROSSI", birthDate: "2011-01-01", schName: "LICEO SCIENTIFICO", schDedication: "G. GALILEI", schCity: "ROMA", schProv: "RM", miurSchoolCode: "RMPS000000", usrType: "S" } },
  grades: { grades: [
    { evtDate: T, evtCode: "GRV0", subjectDesc: "MATEMATICA", displayValue: "7+", decimalValue: 7.25, color: "green", canceled: false, periodPos: 1, periodDesc: "Trimestre", teacherName: "BIANCHI", weightFactor: 1, notesForFamily: "" },
    { evtDate: T, evtCode: "GRV1", subjectDesc: "MATEMATICA", displayValue: "5", decimalValue: 5, color: "red", canceled: false, periodPos: 1, periodDesc: "Trimestre", teacherName: "BIANCHI", weightFactor: 1 },
    { evtDate: T, evtCode: "GRV1", subjectDesc: "LATINO", displayValue: "8", decimalValue: 8, color: "blue", canceled: false, periodPos: 1, periodDesc: "Trimestre", teacherName: "VERDI", weightFactor: 1 } ] },
  homeworks: { items: [{ evtCode: "NEWDC", teacherName: "ROSSI", evtId: 125021, homeworkDesc: "Es. 1-5 p. 100", homeworkDone: false, assignmentDate: T, expiryDate: T, subjectDesc: "FISICA", teacherFiles: [{ fileId: 77, fileName: "traccia.txt" }], teacherLinks: [] }] },
  agenda: { agenda: [{ evtCode: "AGNT", evtDatetimeBegin: `${T}T09:00:00+01:00`, evtDatetimeEnd: `${T}T10:00:00+01:00`, isFullDay: false, notes: "Verifica equazioni", authorName: "BIANCHI", subjectDesc: "MATEMATICA" }] },
  lessons: { lessons: [{ evtDate: T, evtHPos: 1, evtDuration: 1, subjectDesc: "LATINO", authorName: "VERDI", lessonType: "Lezione", lessonArg: "Ablativo assoluto" }] },
  absences: { events: [{ evtDate: T, evtCode: "ABR0", evtHPos: 1, evtValue: 2, isJustified: false }, { evtDate: T, evtCode: "ABA0", isJustified: true }, { evtDate: T, evtCode: "ABU0", evtHPos: 5, evtValue: 1, isJustified: true }] },
  noticeboard: { items: [{ pubDT: `${T}T08:00:00+01:00`, cntTitle: "Circ. 12 - Sciopero", cntCategory: "Circolari", readStatus: false, attachments: [{ fileName: "circ12.docx", attachNum: 1 }], evtCode: "CF", pubId: 1 }] },
  notes: { NTTE: [], NTCL: [{ evtDate: T, authorName: "NERI", evtText: "Disturba la lezione", readStatus: true }], NTWN: [], NTST: [] },
  subjects: { subjects: [{ id: 1, description: "MATEMATICA", teachers: [{ teacherName: "BIANCHI" }] }] },
  periods: { periods: [{ periodPos: 1, periodDesc: "Trimestre", dateStart: "2026-09-14", dateEnd: "2026-12-22", isFinal: false }] },
  didactics: { didacticts: [{ teacherName: "VERDI", folders: [{ folderName: "Esercizi", lastShareDT: T, contents: [
    { contentId: 501, contentName: "es1.pdf", objectId: 9, objectType: "file", shareDT: T },
    { contentId: 502, contentName: "Link al libro", objectId: 10, objectType: "link", shareDT: T }] }] }] },
  calendar: { calendar: [{ dayDate: T, dayStatus: "SD" }, { dayDate: "2026-12-08", dayStatus: "HD" }] },
};
// PDF minimale di 2 pagine
function pdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((t, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, "latin1");
}
// ZIP minimale (deflate) per il .docx
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), comp = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, nb, comp); centrals.push(c, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const FILES = {
  "didactics/item/501": { type: "application/pdf", name: "es1.pdf", body: pdf(["Esercizio uno", "Esercizio due"]) },
  "didactics/item/502": { type: "application/json", body: Buffer.from(JSON.stringify({ item: { link: "https://docs.google.com/document/d/abcdefghijk123/edit" } })) },
  "noticeboard/attach/CF/1/1": { type: "application/octet-stream", name: "circ12.docx", body: zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Sciopero del </w:t></w:r><w:r><w:t xml:space="preserve">20 novembre &amp; uscita</w:t></w:r></w:p><w:p><w:r><w:t>Seconda riga</w:t></w:r></w:p></w:body></w:document>' }) },
  "homeworks/downloadTeacherFile/NEWDC/125021/77": { type: "text/plain; charset=utf-8", name: "traccia.txt", body: Buffer.from("Traccia: risolvi gli esercizi") },
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
  const fm = req.url.match(/\/students\/1234567\/(.+)$/);
  const file = fm && FILES[fm[1]];
  if (file) {
    res.writeHead(200, { "content-type": file.type, ...(file.name ? { "content-disposition": `attachment; filename=${file.name}` } : {}) });
    return res.end(file.body);
  }
  if (/\/(didactics\/item|noticeboard\/attach|homeworks\/downloadTeacherFile)\//.test(req.url))
    return send(404, { statusCode: 404, error: "151:CvvRestApi/no content available", message: "there is nothing attached to this item" });
  const m = req.url.match(/\/students\/1234567\/([a-z]+)/);
  if (!m) return send(404, { error: "102:CvvRestApi/wrong uri" });
  const key = m[1] === "absences" ? "absences" : m[1];
  if (data[key]) return send(200, data[key]);
  send(404, { error: "nope" });
}).listen(9999, () => console.log("mock on 9999"));
process.on("SIGTERM", () => { console.log("logins:", logins); process.exit(0); });
