import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowed, api } from "../../lib/api";
import { dayAndTime, since } from "../../lib/format";
import { useNow, useStaffCity } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityPicker } from "../../components/CityPicker";
import { Empty, PageHead, Pill, Problem } from "../../components/ui";

interface Org {
  id: string;
  name: string;
  kind: "FLEET" | "CORPORATE";
  legalName: string | null;
  tin: string | null;
  status: "PENDING" | "VERIFIED" | "SUSPENDED";
  createdAt: string;
  members: number;
}

/** Workflow 03: companies wait here until an onboarding officer checks their TIN and papers. */
export function Onboarding() {
  const { staff } = useSession();
  const { cities, cityId, setCityId } = useStaffCity("org:read");
  const [status, setStatus] = useState<Org["status"]>("PENDING");
  const qc = useQueryClient();
  const orgs = useQuery({
    queryKey: ["orgs", cityId, status],
    enabled: !!cityId,
    queryFn: () => api<Org[]>("staff", `/api/identity/organizations?cityId=${cityId}&status=${status}`),
  });
  const verify = useMutation({
    mutationFn: (id: string) => api("staff", `/api/identity/organizations/${id}/verify`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orgs"] }),
  });
  const suspend = useMutation({
    mutationFn: (a: { id: string; reason: string }) => api("staff", `/api/identity/organizations/${a.id}/suspend`, { body: { reason: a.reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orgs"] }),
  });
  const canVerify = allowed(staff.principal, "org:verify", { cityId: cityId ?? undefined });
  const canSuspend = allowed(staff.principal, "org:suspend", { cityId: cityId ?? undefined });
  const list = orgs.data ?? [];
  const now = useNow(60_000);

  return (
    <div className="page">
      <PageHead
        title="Companies"
        lede="Fleet companies can't add drivers, and company accounts can't book, until they're verified here."
        right={<CityPicker cities={cities} value={cityId} onChange={setCityId} />}
      />
      <div className="tabs" role="tablist">
        {(["PENDING", "VERIFIED", "SUSPENDED"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>
            {s === "PENDING" ? "Waiting" : s === "VERIFIED" ? "Verified" : "Suspended"}
          </button>
        ))}
      </div>
      <Problem error={orgs.error ?? verify.error ?? suspend.error} />
      {!orgs.isLoading && list.length === 0 ? <Empty title={status === "PENDING" ? "Nobody waiting." : "None."}>{status === "PENDING" ? "New registrations appear here." : null}</Empty> : null}
      {list.length ? (
        <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Company</th><th>Kind</th><th>TIN</th><th className="num">People</th><th>Registered</th><th /></tr></thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} className={status === "PENDING" && now - new Date(o.createdAt).getTime() > 2 * 86_400_000 ? "urgent" : ""}>
                <td><strong>{o.name}</strong><div className="small muted">{o.legalName}</div></td>
                <td>{o.kind === "FLEET" ? <Pill tone="blue">fleet</Pill> : <Pill tone="amber">company account</Pill>}</td>
                <td className="mono">{o.tin ?? "—"}</td>
                <td className="num mono">{o.members}</td>
                <td className="small">{dayAndTime(o.createdAt)}<div className="muted">{since(o.createdAt, now)} ago</div></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {o.status === "PENDING" && canVerify ? <button className="btn sm" disabled={verify.isPending} onClick={() => verify.mutate(o.id)}>Verify</button> : null}{" "}
                  {o.status !== "SUSPENDED" && canSuspend ? (
                    <button className="link danger" onClick={() => {
                      const reason = prompt(`Why suspend ${o.name}? (10+ characters, goes to the audit log)`);
                      if (reason && reason.trim().length >= 10) suspend.mutate({ id: o.id, reason: reason.trim() });
                    }}>suspend</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}
    </div>
  );
}
