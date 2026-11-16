/** Lettura dei file allegati in ClasseViva (get_file): Didattica, Bacheca, Compiti. */
import { ClasseVivaClient, ClasseVivaError } from "./classeviva.js";

export const DEFAULT_MAX_CHARS = 30_000;
export const HARD_MAX_CHARS = 100_000;
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const MAX_UNZIPPED = 60 * 1024 * 1024;

export type FileSource = "didattica" | "bacheca" | "compito";
export interface FileArgs {
  tipo: FileSource;
  id: string;
  allegato?: string | number;
  pagina?: number;
  offset?: number;
  max_caratteri?: number;
}

const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-tex|rtf)\b)|\+xml$|\+json$/i;
const TEXT_EXT = /\.(txt|md|csv|tsv|json|xml|html?|ya?ml|tex|py|js|ts|java|c|cpp|h|sql|log)$/i;
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  odp: "application/vnd.oasis.opendocument.presentation",
  doc: "application/msword", ppt: "application/vnd.ms-powerpoint", xls: "application/vnd.ms-excel",
  txt: "text/plain", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", zip: "application/zip",
};
const KIND_LABEL: [RegExp, string][] = [
  [/^application\/pdf/, "PDF"],
  [/^image\//, "immagine"], [/^video\//, "video"], [/^audio\//, "audio"],
  [/wordprocessingml/, "Word (docx)"], [/msword/, "Word (doc, vecchio formato)"],
  [/presentationml/, "PowerPoint (pptx)"], [/ms-powerpoint/, "PowerPoint (ppt, vecchio formato)"],
  [/spreadsheetml|ms-excel/, "Excel"],
  [/opendocument\.text/, "OpenDocument (odt)"], [/opendocument\.presentation/, "OpenDocument (odp)"],
  [/zip|compressed|x-rar|x-7z/, "archivio compresso"],
  [/^text\//, "testo"],
];
const kindOf = (mime: string) => KIND_LABEL.find(([re]) => re.test(mime))?.[1] ?? (mime || "sconosciuto");
const ext = (name?: string) => (name?.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toLowerCase();

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, "");
}

/** Taglia `text` da `offset` per al massimo `max` caratteri, senza spezzare (se possibile) una riga. */
function window(text: string, offset: number, max: number) {
  const start = Math.min(Math.max(0, offset), text.length);
  let end = Math.min(text.length, start + max);
  if (end < text.length) {
    const nl = text.lastIndexOf("\n", end);
    if (nl > start + max * 0.7) end = nl + 1;
  }
  return { chunk: text.slice(start, end), start, end, total: text.length };
}

async function pdfText(bytes: Uint8Array, fromPage: number, maxChars: number) {
  const { getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch (e) {
    const msg = (e as Error)?.message ?? "";
    if (/password/i.test(msg)) throw new ClasseVivaError("Il PDF è protetto da password: non posso leggerlo.", 422);
    throw new ClasseVivaError(`Non riesco ad aprire il PDF (${msg || "file danneggiato?"}).`, 422);
  }
  try {
    const total = pdf.numPages;
    const start = Math.min(Math.max(1, fromPage), Math.max(1, total));
    const parts: string[] = [];
    let chars = 0, last = start - 1, cut = false;
    for (let p = start; p <= total; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let txt = "";
      for (const it of tc.items as any[]) {
        if (typeof it.str !== "string") continue;
        txt += it.str + (it.hasEOL ? "\n" : "");
      }
      txt = txt.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      page.cleanup();
      const block = `--- Pagina ${p} ---\n${txt || "(nessun testo: forse un'immagine o una scansione)"}\n`;
      if (chars + block.length > maxChars && parts.length) { cut = true; break; }
      if (block.length > maxChars) { parts.push(block.slice(0, maxChars) + "\n[…pagina tagliata…]\n"); last = p; chars += maxChars; cut = p < total; break; }
      parts.push(block); chars += block.length; last = p;
    }
    const textChars = parts.join("").replace(/--- Pagina \d+ ---|\(nessun testo[^)]*\)/g, "").trim().length;
    return { text: parts.join("\n"), total, start, last, cut: cut || last < total, empty: textChars === 0 };
  } finally {
    void (pdf as any).destroy?.();
  }
}

// ---------- ZIP minimale (docx/pptx/odt): central directory + DecompressionStream ----------
interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number }

function zipEntries(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ClasseVivaError("File Office non valido (archivio danneggiato).", 422);
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const td = new TextDecoder();
  for (let i = 0; i < n && p + 46 <= b.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    out.push({ method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true),
      offset: dv.getUint32(p + 42, true), name: td.decode(b.subarray(p + 46, p + 46 + nl)) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function zipRead(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new ClasseVivaError("File Office non valido.", 422);
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = b.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new ClasseVivaError("Compressione del file Office non supportata.", 422);
  if (e.usize > MAX_UNZIPPED) throw new ClasseVivaError("Il file Office è troppo grande da leggere qui.", 413);
  const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

const XML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e.toLowerCase()]);

/** Testo da XML Office: `tag` = elemento di testo, `para` = fine paragrafo, `br` = a capo/tab. */
function xmlText(xml: string, tag: string, para: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|</${para}>|<(?:w:br|a:br|text:line-break|w:tab|text:tab)\\b[^>]*/>`, "g");
  let out = "";
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += unxml(m[1].replace(/<[^>]+>/g, ""));
    else if (m[0].startsWith("</")) out += "\n";
    else out += /tab/.test(m[0]) ? "\t" : "\n";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function officeText(bytes: Uint8Array, kind: "docx" | "pptx" | "odt" | "odp"): Promise<string> {
  const entries = zipEntries(bytes);
  const get = (name: string) => entries.find((e) => e.name === name);
  const read = async (e: ZipEntry) => decodeText(await zipRead(bytes, e));
  if (kind === "docx") {
    const main = get("word/document.xml");
    if (!main) throw new ClasseVivaError("Documento Word senza contenuto leggibile.", 422);
    return xmlText(await read(main), "w:t", "w:p");
  }
  if (kind === "pptx") {
    const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => Number(a.name.match(/(\d+)\.xml$/)![1]) - Number(b.name.match(/(\d+)\.xml$/)![1]));
    const parts: string[] = [];
    for (const [i, s] of slides.entries()) parts.push(`--- Slide ${i + 1} ---\n${xmlText(await read(s), "a:t", "a:p") || "(nessun testo: solo immagini)"}`);
    return parts.join("\n\n");
  }
  const content = get("content.xml");
  if (!content) throw new ClasseVivaError("Documento OpenDocument senza contenuto leggibile.", 422);
  const xml = await read(content);
  return xml.replace(/<text:(?:p|h)\b[^>]*\/>/g, "\n").replace(/<text:s\b[^>]*\/>/g, " ")
    .replace(/<text:tab\b[^>]*\/>/g, "\t").replace(/<text:line-break\b[^>]*\/>/g, "\n")
    .replace(/<\/text:(?:p|h)>/g, "\n").replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, (e) => unxml(e))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- sorgenti ----------
function sourcePath(a: FileArgs): string {
  const id = a.id.trim();
  if (a.tipo === "didattica") {
    if (!/^\d+$/.test(id)) throw new ClasseVivaError("Per la didattica serve l'id numerico del contenuto (campo `id` di get_didactics).", 400);
    return `didactics/item/${id}`;
  }
  if (a.tipo === "bacheca") {
    const m = id.match(/^([A-Za-z0-9_]+)\/(\d+)$/);
    if (!m) throw new ClasseVivaError("Per la bacheca serve l'id della circolare nella forma CODICE/NUMERO (campo `id` di get_noticeboard, es. CF/123456).", 400);
    const n = String(a.allegato ?? 1).trim();
    if (!/^\d+$/.test(n)) throw new ClasseVivaError("`allegato` deve essere il numero dell'allegato (campo `numero` in get_noticeboard).", 400);
    return `noticeboard/attach/${m[1]}/${m[2]}/${n}`;
  }
  const m = id.match(/^([A-Za-z0-9_]+)\/(\d+)$/);
  if (!m) throw new ClasseVivaError("Per i compiti serve l'id del compito nella forma CODICE/NUMERO (campo `id` di get_homework, es. NEWDC/125021).", 400);
  const f = String(a.allegato ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(f)) throw new ClasseVivaError("Per i compiti serve anche `allegato` = id del file del docente (campo `file[].id` di get_homework).", 400);
  return `homeworks/downloadTeacherFile/${m[1]}/${m[2]}/${encodeURIComponent(f)}`;
}

const isGoogleLink = (u: string) => /^https?:\/\/([a-z0-9-]+\.)*google\.com\//i.test(u);

function linkResult(base: object, url: string) {
  return {
    ...base, leggibile: false, link: url,
    nota: isGoogleLink(url)
      ? "È un link a Google Drive/Documenti: aprilo dal link (con il connettore Classroom puoi leggerlo con get_file)."
      : "È un link a una pagina esterna: aprilo dal link.",
  };
}

/** Risposte JSON di didactics/item: link o testo condiviso dal docente (formato non documentato, gestione tollerante). */
function fromJson(base: Record<string, unknown>, j: any, opts: FileArgs, max: number) {
  const item = j?.item ?? j?.content ?? j;
  const pickStr = (...keys: string[]) => {
    for (const k of keys) { const v = item?.[k] ?? j?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return undefined;
  };
  const url = pickStr("link", "url", "href", "objectLink", "contentUrl");
  if (url && /^https?:\/\//i.test(url)) return linkResult(base, url);
  const text = pickStr("text", "contentText", "body", "description", "notes");
  if (text) return textResult({ ...base, tipo: "testo" }, text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""), opts, max);
  return { ...base, leggibile: false, nota: "ClasseViva ha restituito un contenuto in un formato che non riconosco. Aprilo da ClasseViva." };
}

function textResult(base: object, text: string, opts: FileArgs, max: number, extraNote?: string) {
  const w = window(text, opts.offset ?? 0, max);
  const cut = w.end < w.total;
  return {
    ...base, leggibile: text.trim().length > 0,
    caratteri_totali: w.total, da_carattere: w.start, a_carattere: w.end,
    troncato: cut || undefined,
    nota: [extraNote, !text.trim() ? "Nessun testo trovato nel file (forse contiene solo immagini)." : undefined,
      cut ? `Testo tagliato: mostrati i caratteri ${w.start}-${w.end} di ${w.total}. Per continuare richiama get_file con offset=${w.end}.` : undefined]
      .filter(Boolean).join(" ") || undefined,
    contenuto: w.chunk,
  };
}

export async function readClasseVivaFile(c: ClasseVivaClient, a: FileArgs) {
  const path = sourcePath(a);
  const max = Math.min(Math.max(1000, a.max_caratteri ?? DEFAULT_MAX_CHARS), HARD_MAX_CHARS);
  const { bytes, contentType, fileName } = await c.studentFile(path, MAX_DOWNLOAD);
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const e = ext(fileName);
  const mime = (!ct || ct === "application/octet-stream" || ct === "binary/octet-stream") ? (MIME_BY_EXT[e] ?? ct) : ct;
  const base: Record<string, unknown> = {
    sorgente: a.tipo, nome: fileName, tipo: kindOf(mime), tipo_mime: mime || undefined,
    dimensione_kb: Math.round(bytes.byteLength / 1024),
  };

  if (/json/.test(mime) && !fileName) {
    let j: any;
    try { j = JSON.parse(decodeText(bytes)); } catch { /* non JSON */ }
    if (j !== undefined) return fromJson(base, j, a, max);
  }

  const magic = decodeText(bytes.subarray(0, 5));
  if (mime === "application/pdf" || magic === "%PDF-") {
    const r = await pdfText(bytes, a.pagina ?? 1, max);
    const note: string[] = [];
    if (r.empty) note.push("Il PDF non contiene testo selezionabile (probabilmente è una scansione o sono immagini): non posso leggerlo, aprilo da ClasseViva.");
    if (r.cut && r.last < r.total) note.push(`Mostrate le pagine ${r.start}-${r.last} di ${r.total}. Per continuare richiama get_file con pagina=${r.last + 1}.`);
    return {
      ...base, tipo: "PDF", leggibile: !r.empty,
      pagine_totali: r.total, da_pagina: r.start, a_pagina: r.last,
      troncato: (r.cut && r.last < r.total) || undefined,
      nota: note.join(" ") || undefined,
      contenuto: r.text,
    };
  }

  const office = /wordprocessingml/.test(mime) || e === "docx" ? "docx"
    : /presentationml/.test(mime) || e === "pptx" ? "pptx"
    : /opendocument\.text/.test(mime) || e === "odt" ? "odt"
    : /opendocument\.presentation/.test(mime) || e === "odp" ? "odp" : undefined;
  if (office && magic.startsWith("PK")) {
    const text = await officeText(bytes, office);
    return textResult(base, text, a, max, office === "pptx" || office === "odp" ? "Solo il testo delle slide: immagini e grafici non sono inclusi." : undefined);
  }

  if (TEXT_MIME.test(mime) || TEXT_EXT.test(fileName ?? "")) {
    let text = decodeText(bytes);
    if (/html/.test(mime) || /\.html?$/i.test(fileName ?? "")) {
      const url = text.match(/http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i)?.[1];
      if (url && /^https?:\/\//i.test(url)) return linkResult(base, url);
      text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m) => unxml(m));
    }
    return textResult(base, text, a, max);
  }

  return {
    ...base, leggibile: false,
    nota: `Non posso leggere il contenuto di questo tipo di file (${kindOf(mime)}). Leggo PDF con testo, Word (.docx), PowerPoint (.pptx), OpenDocument e file di testo. Aprilo da ClasseViva.`,
  };
}
