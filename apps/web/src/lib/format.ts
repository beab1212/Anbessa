// Formatting. Money is in santim (1 ETB = 100); times are shown in Addis Ababa time.

const TZ = "Africa/Addis_Ababa";

export const CITY_NAMES: Record<string, string> = { "addis-ababa": "Addis Ababa", hawassa: "Hawassa" };
export const CITIES = Object.keys(CITY_NAMES);

export function birr(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  const v = minor / 100;
  return `${v.toLocaleString("en-ET", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} ETB`;
}

export function clock(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export function dayAndTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

/** "4 min", "1 h 05", "just now" — how long something has been waiting. */
export function since(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

/** Short id for tables and phone calls: the last 6 characters, upper case. */
export const shortId = (id: string) => id.replace(/-/g, "").slice(-6).toUpperCase();

/** +251911223344 → +251 91 122 3344 */
export function phone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const m = /^\+251(\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+251 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** Ethiopian mobile in E.164 from what people type: 0911…, 911…, +251911… */
export function toE164(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  const m = /^(?:\+?251|0)?([79]\d{8})$/.exec(digits);
  return m ? `+251${m[1]}` : null;
}

/** Phone-only accounts carry a placeholder address derived from the number (Auth.md §17, I4). */
export const phoneToPlaceholderEmail = (e164: string) => `${e164.slice(1)}@phone.anbessa.invalid`;
export function placeholderEmailToPhone(email: string): string | null {
  const m = /^(\d+)@phone\.anbessa\.invalid$/.exec(email);
  return m ? `+${m[1]}` : null;
}

export const STATUS_LABEL: Record<string, string> = {
  requested: "finding driver",
  matched: "driver assigned",
  en_route: "driver on the way",
  in_progress: "on trip",
  completed: "completed",
  cancelled: "cancelled",
};
