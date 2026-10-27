// Scheduled rides in a city (workflow 12), for dispatch and the call center (trip:read @ CITY):
// what is booked ahead, what has started matching, and what needs a dispatcher (escalated).
// trip-service GET /api/trips/scheduled?cityId=.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { allowed } from "../../lib/api";
import { birr, dayAndTime, shortId, STATUS_LABEL } from "../../lib/format";
import { useNow, useStaffCity } from "../../lib/hooks";
import { METHOD_WORD } from "../../lib/reports";
import { useSession } from "../../lib/session";
import { cancelScheduled, failReasonLabel, SCHEDULED_LABEL, scheduledTone, useScheduled, type ScheduledRide } from "../../lib/trips2";
import { CityPicker } from "../../components/CityPicker";
import { Empty, PageHead, Pill, Problem, Stat, TripStatus } from "../../components/ui";

const CHANNEL: Record<string, string> = { APP: "app", PHONE: "phone", CORPORATE_PORTAL: "company" };

/** "in 2 h 10", "in 25 min", "12 min ago" */
export function untilLabel(iso: string, now: number): string {
  const m = Math.round((Date.parse(iso) - now) / 60_000);
  const abs = Math.abs(m);
  const text = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.floor(abs / 60)} h ${String(abs % 60).padStart(2, "0")}` : `${Math.round(abs / 1440)} days`;
  return m >= 0 ? `in ${text}` : `${text} ago`;
}

export function StaffScheduledPage() {
  const { staff } = useSession();
  const { cities, cityId, setCityId } = useStaffCity("trip:read");
  const [status, setStatus] = useState<"upcoming" | "all">("upcoming");
  const now = useNow(30_000);
  const qc = useQueryClient();
  const list = useScheduled("staff", { cityId: cityId ?? undefined, status }, !!cityId);
  const cancel = useMutation({
    mutationFn: (id: string) => cancelScheduled("staff", id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scheduled"] }),
  });
  const rows = list.data ?? [];
  const canCancel = allowed(staff.principal, "trip:cancel", { cityId: cityId ?? undefined });
  const nextHour = rows.filter((s) => s.status === "SCHEDULED" && Date.parse(s.scheduledFor) - now < 3600_000).length;
  const escalated = rows.filter((s) => s.escalatedAt && s.tripStatus === "requested").length;

  if (!cityId) return <div className="page"><Empty title="Nothing here for your roles." /></div>;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      <PageHead
        title="Scheduled rides"
        lede="Rides booked ahead. Each one enters normal matching 15 minutes before the pickup (30 at night); one nobody accepts is flagged on the board for a dispatcher."
        right={
          <>
            <CityPicker cities={cities} value={cityId} onChange={setCityId} />
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={status === "upcoming"} onClick={() => setStatus("upcoming")}>Upcoming</button>
              <button role="tab" aria-selected={status === "all"} onClick={() => setStatus("all")}>All</button>
            </div>
          </>
        }
      />
      {status === "upcoming" && list.data ? (
        <div className="stats">
          <Stat label="Booked ahead" value={rows.length} />
          <Stat label="Pickup within an hour" value={nextHour} />
          <Stat label="Escalated, still unmatched" value={escalated} alert={escalated > 0} />
        </div>
      ) : null}
      <Problem error={list.error ?? cancel.error} />
      {list.isLoading ? <p className="muted">Loading…</p> : null}
      {list.data && rows.length === 0 ? <Empty title={status === "upcoming" ? "No rides booked ahead." : "No scheduled rides yet."} /> : null}
      {rows.length ? <ScheduledTable rows={rows} now={now} tripLink={(id) => `/staff/trips/${id}`} onCancel={canCancel ? (s) => confirm(`Cancel the ${dayAndTime(s.scheduledFor)} ride from ${s.pickup.address ?? "the pin"}? It's free; the rider is told.`) && cancel.mutate(s.id) : undefined} busy={cancel.isPending} showChannel /> : null}
    </div>
  );
}

/** The table both the staff and the company page use. */
export function ScheduledTable({ rows, now, tripLink, onCancel, busy, showChannel = false, riderName }: {
  rows: ScheduledRide[];
  now: number;
  tripLink: (tripId: string) => string;
  onCancel?: (s: ScheduledRide) => void;
  busy?: boolean;
  showChannel?: boolean;
  riderName?: (userId: string) => string | null;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Pickup time</th><th>Status</th><th>Rider</th><th>From → to</th><th>Car</th><th>Payment</th>{showChannel ? <th>Booked by</th> : null}<th className="num">Fare</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="small">
                {dayAndTime(s.scheduledFor)}
                {s.status === "SCHEDULED" ? <div className="xs muted">{untilLabel(s.scheduledFor, now)}</div> : null}
              </td>
              <td>
                {s.tripId && s.tripStatus ? (
                  <Link to={tripLink(s.tripId)}><TripStatus status={s.tripStatus} label={STATUS_LABEL[s.tripStatus] ?? s.tripStatus} /></Link>
                ) : (
                  <Pill tone={scheduledTone(s.status)}>{SCHEDULED_LABEL[s.status] ?? s.status}</Pill>
                )}
                {s.escalatedAt && s.tripStatus === "requested" ? <> <Pill tone="red" pulse>needs a driver</Pill></> : null}
                {s.failReason ? <div className="xs muted">{failReasonLabel(s.failReason)}</div> : null}
              </td>
              <td className="small">{riderName?.(s.riderUserId) ?? <span className="mono">{shortId(s.riderUserId)}</span>}</td>
              <td className="small">{s.pickup.address ?? "pin"} → {s.dropoff.address ?? "pin"}{s.purpose ? <div className="xs muted">{s.purpose}</div> : null}</td>
              <td className="small">{s.vehicleType}</td>
              <td className="small">{METHOD_WORD[s.paymentMethod] ?? s.paymentMethod}</td>
              {showChannel ? <td className="small">{CHANNEL[s.channel] ?? s.channel}</td> : null}
              <td className="num">{birr(s.fare.estimateMinor)}</td>
              <td>{onCancel && s.status === "SCHEDULED" ? <button className="link danger" disabled={busy} onClick={() => onCancel(s)}>cancel</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
