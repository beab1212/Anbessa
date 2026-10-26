import { useEffect, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { ApiError } from "../lib/api";

export function Logo({ size = 1.75 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: `${size}rem`, height: `${size}rem`, fontSize: `${size * 0.55}rem` }} aria-hidden="true">
      አ
    </span>
  );
}

export function Brand({ subtitle = "Operations" }: { subtitle?: string }) {
  return (
    <div className="brand">
      <Logo />
      <span className="name">
        Anbessa
        <small>{subtitle}</small>
      </span>
    </div>
  );
}

type Tone = "amber" | "blue" | "green" | "red" | "grey";

export function Pill({ children, tone = "grey", pulse = false }: { children: ReactNode; tone?: Tone; pulse?: boolean }) {
  return <span className={`pill ${tone} ${pulse ? "pulse" : ""}`}>{children}</span>;
}

const TRIP_TONE: Record<string, Tone> = { requested: "amber", matched: "blue", en_route: "blue", in_progress: "green", completed: "grey", cancelled: "red" };
export const tripTone = (status: string): Tone => TRIP_TONE[status] ?? "grey";

export function TripStatus({ status, label }: { status: string; label: string }) {
  return <Pill tone={tripTone(status)} pulse={status === "requested"}>{label}</Pill>;
}

export function Field({ label, hint, className = "", ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} {...input} />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function SelectField({ label, children, ...select }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} {...select}>{children}</select>
    </div>
  );
}

export function TextArea({ label, hint, ...ta }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <textarea id={id} {...ta} />
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/** Errors in words a person can act on. */
export function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? error.status === 403
        ? "You don't have permission for this. If you should, ask a super admin to check your roles."
        : error.status === 503
          ? `${error.message}. Try again in a minute.`
          : error.message
      : "Something went wrong. Check your connection and try again.";
  return (
    <div className="alert error" role="alert">
      <AlertCircle />
      <span>{message}</span>
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "error" ? AlertCircle : Info;
  return (
    <div className={`alert ${tone}`}>
      <Icon />
      <span>{children}</span>
    </div>
  );
}

export function PageHead({ title, lede, right }: { title: ReactNode; lede?: ReactNode; right?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p>{lede}</p> : null}
      </div>
      {right ? <div className="row">{right}</div> : null}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, alert = false }: { label: string; value: ReactNode; sub?: ReactNode; alert?: boolean }) {
  return (
    <div className={`stat ${alert ? "urgent" : ""}`}>
      <span className="label">{label}</span>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
