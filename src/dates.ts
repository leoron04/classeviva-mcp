/** Date in fuso Europe/Rome, formato YYYY-MM-DD. */
export function todayRome(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Primo giorno dell'anno scolastico corrente (1 settembre). */
export function schoolYearStart(today = todayRome()): string {
  const [y, m] = today.split("-").map(Number);
  return `${m >= 9 ? y : y - 1}-09-01`;
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export const toApi = (iso: string) => iso.replace(/-/g, "");
export const minDate = (a: string, b: string) => (a < b ? a : b);
export const maxDate = (a: string, b: string) => (a > b ? a : b);
