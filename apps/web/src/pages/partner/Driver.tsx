// /partner/org/:orgId/drivers/:userId: a fleet driver's record for the fleet owner
// (onboarding status, documents, which company cars they may use, whether they're driving now).

import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { allowed, api, ApiError, authCall } from "../../lib/api";
import { CITY_NAMES, dayAndTime } from "../../lib/format";
import { KIND_LABEL, statusTone, statusWord, vehicleName, type DriverDetail } from "../../lib/fleet";
import { roleList } from "../../lib/partner";
import { useSession } from "../../lib/session";
import { Empty, Notice, PageHead, Pill, Problem } from "../../components/ui";
import { memberName, type Member } from "./Fleet";

const StatusPill = ({ status }: { status: string }) => <Pill tone={statusTone(status)}>{statusWord(status)}</Pill>;

const DRIVER_NOTE: Record<string, string> = {
  APPLIED: "They've started applying in the Anbessa app but haven't sent it for review yet.",
  PENDING_REVIEW: "Waiting for our onboarding team, usually within a day.",
  ACTIVE: "Approved. They can drive any company car you allow them to use.",
  SUSPENDED: "Suspended: they can't drive until Anbessa reinstates them.",
};

export function PartnerDriverPage() {
  const { orgId, userId } = useParams();
  const { partner } = useSession();
  const p = partner.principal;
  const org = useQuery({
    queryKey: ["org", orgId],
    queryFn: () => authCall<{ name: string; kind: "FLEET" | "CORPORATE"; members: Member[] }>("partner", `/organization/get-full-organization?organizationId=${orgId}`),
  });
  const mayRead = allowed(p, "driver:read", { orgId });
  const isFleet = org.data?.kind === "FLEET";
  const driver = useQuery({
    queryKey: ["partner-driver", orgId, userId],
    enabled: mayRead && isFleet,
    retry: false,
    refetchInterval: 30_000,
    queryFn: () => api<DriverDetail>("partner", `/api/fleet/drivers/${userId}?orgId=${orgId}`),
  });

  if (org.isLoading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (org.error) return <div className="page"><Problem error={org.error} /></div>;
  const o = org.data!;
  const member = o.members.find((m) => m.userId === userId);
  const name = member ? memberName(member) : "Driver";
  const crumb = <p className="xs muted" style={{ margin: 0 }}><Link to={`/partner/org/${orgId}`}>{o.name} · drivers</Link> / {name}</p>;

  if (!isFleet) return <div className="page stack">{crumb}<Empty title="Drivers belong to fleets.">This is a company account; it has no drivers.</Empty></div>;
  if (!mayRead) return <div className="page stack">{crumb}<Empty title="Only the fleet owner sees driver records.">Ask the owner of {o.name} if you need this.</Empty></div>;
  if (!member || !roleList(member.role).includes("fleet_driver")) {
    return <div className="page stack">{crumb}<Empty title="Not a driver in this fleet.">They may have been removed. <Link to={`/partner/org/${orgId}`}>Back to the people list</Link>.</Empty></div>;
  }
  if (driver.isLoading) return <div className="page stack">{crumb}<p className="muted">Loading…</p></div>;
  if (driver.error instanceof ApiError && driver.error.status === 404) {
    return (
      <div className="page stack">
        {crumb}
        <PageHead title={<span className="mono">{name}</span>} lede="Fleet driver" />
        <Empty title="Hasn't applied as a driver yet.">They joined the fleet; next they apply in the Anbessa app (licence, ID, photo). You'll see their progress here.</Empty>
      </div>
    );
  }
  if (driver.error) return <div className="page stack">{crumb}<Problem error={driver.error} /></div>;
  const d = driver.data!;
  const ours = d.fleetVehicles.filter((v) => v.ownerOrgId === orgId);
  const usable = ours.filter((v) => v.authorization.status === "ACTIVE");
  const sessionCar = d.session ? [...d.fleetVehicles, ...d.vehicles].find((v) => v.id === d.session!.vehicleId) : undefined;

  return (
    <div className="page stack" style={{ gap: "1rem" }}>
      {crumb}
      <PageHead
        title={<span className="row" style={{ gap: "0.6rem" }}>{d.fullName} <StatusPill status={d.status} /></span>}
        lede={<>Phone <span className="mono">{name}</span> · licence <span className="mono">{d.licenseNumber}</span> · {CITY_NAMES[d.cityId] ?? d.cityId}{d.activatedAt ? ` · driving since ${dayAndTime(d.activatedAt)}` : ` · applied ${dayAndTime(d.createdAt)}`}</>}
      />
      <Notice tone={d.status === "SUSPENDED" ? "error" : d.status === "ACTIVE" ? "ok" : "info"}>
        {DRIVER_NOTE[d.status] ?? statusWord(d.status)}
        {d.status === "SUSPENDED" && d.statusReason === "DOCUMENT_EXPIRED" ? " A document expired; they upload the renewed one in the app." : ""}
        {d.reviewNote ? <> Last note from Anbessa: {d.reviewNote}</> : null}
      </Notice>

      <div className="two-col wide-left">
        <section className="card">
          <div className="card-head"><h2>Documents</h2></div>
          <div className="card-body">
            <p className="small muted" style={{ marginTop: 0 }}>The driver uploads these in the Anbessa app. You see where each one stands; only Anbessa's onboarding team opens the files.</p>
            <table className="table">
              <thead><tr><th>Document</th><th>Status</th><th>Expires</th></tr></thead>
              <tbody>
                {d.documents.map((x) => (
                  <tr key={x.kind}>
                    <td>{KIND_LABEL[x.kind] ?? x.kind}{x.required ? null : <span className="xs muted"> · optional</span>}</td>
                    <td>
                      {x.document ? <StatusPill status={x.document.status} /> : <span className="muted small">not uploaded</span>}
                      {x.document?.status === "REJECTED" && x.document.rejectReason ? <div className="xs muted">{x.document.rejectReason}</div> : null}
                    </td>
                    <td className="small">
                      {x.document?.expiresAt ?? <span className="muted">—</span>}
                      {x.document?.expiringSoon ? <div className="xs" style={{ color: "var(--warning)" }}>expires soon</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.status !== "ACTIVE" && d.missingForSubmit.length ? (
              <p className="small muted" style={{ marginBottom: 0 }}>Still to upload: {d.missingForSubmit.map((k) => KIND_LABEL[k]?.toLowerCase() ?? k).join(", ")}.</p>
            ) : null}
          </div>
        </section>

        <div className="stack" style={{ gap: "1rem", alignContent: "start" }}>
          <div className="card">
            <div className="card-head"><h2>Right now</h2></div>
            <div className="card-body small">
              {d.session ? (
                <><Pill tone="green" pulse>online</Pill> since {dayAndTime(d.session.startedAt)} in{" "}
                  {sessionCar ? (sessionCar.ownerOrgId === orgId ? <Link className="mono" to={`/partner/org/${orgId}/vehicles/${sessionCar.id}`}>{sessionCar.plateNumber}</Link> : <span className="mono">{sessionCar.plateNumber}</span>) : "a car"}
                </>
              ) : <span className="muted">Offline</span>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Company cars <span className="muted mono small">{usable.length}</span></h2></div>
            <div className="card-body">
              {ours.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>None yet. {d.status === "ACTIVE" ? "Allow them a car on its vehicle page." : "Once they're approved, allow them a car on its vehicle page."}</p>
              ) : (
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: "0.5rem" }}>
                  {ours.map((v) => (
                    <li key={v.id} className="row between small">
                      <Link className="mono" to={`/partner/org/${orgId}/vehicles/${v.id}`}>{v.plateNumber}</Link>
                      <span className="muted">{vehicleName(v)}</span>
                      <span>
                        {v.authorization.status === "ACTIVE" ? <Pill tone="green">allowed</Pill> : <Pill>taken away</Pill>}
                        {v.authorization.status === "ACTIVE" && v.authorization.validUntil ? <span className="xs muted"> until {dayAndTime(v.authorization.validUntil)}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {d.vehicles.length ? <p className="xs muted" style={{ margin: "0.75rem 0 0" }}>They also have {d.vehicles.length} car{d.vehicles.length > 1 ? "s" : ""} of their own on Anbessa: {d.vehicles.map((v) => v.plateNumber).join(", ")}.</p> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
