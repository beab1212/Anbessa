import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { allowed, api } from "../../lib/api";
import { dayAndTime, since } from "../../lib/format";
import { useNow, useStaffCity } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CityPicker } from "../../components/CityPicker";
import { DocumentChecklist, useDocuments } from "../../components/Documents";
import { KIND_LABEL } from "../../lib/fleet";
import { Drawer, Empty, Notice, PageHead, Pill, Problem } from "../../components/ui";

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
  const [params, setParams] = useSearchParams();
  const openId = params.get("org");
  const all = useQuery({ queryKey: ["orgs", cityId, "all"], enabled: !!cityId && !!openId, queryFn: () => api<Org[]>("staff", `/api/identity/organizations?cityId=${cityId}`) });
  const open = (orgs.data ?? []).find((o) => o.id === openId) ?? all.data?.find((o) => o.id === openId) ?? null;
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
                  <button className="btn ghost sm" onClick={() => setParams({ org: o.id })}><FileText /> Documents</button>{" "}
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
      {open && cityId ? (
        <CompanyDrawer org={open} cityId={cityId} canVerify={canVerify} verifying={verify.isPending}
          onVerify={() => verify.mutate(open.id)} onClose={() => setParams({})} />
      ) : null}
    </div>
  );
}

/** The company's papers (fleet-service documents) next to the verify decision (auth-service). */
function CompanyDrawer({ org, cityId, canVerify, verifying, onVerify, onClose }: { org: Org; cityId: string; canVerify: boolean; verifying: boolean; onVerify: () => void; onClose: () => void }) {
  const { staff } = useSession();
  const docs = useDocuments("staff", "ORGANIZATION", org.id);
  const missing = docs.data?.missingForApproval ?? [];
  return (
    <Drawer title={org.name} onClose={onClose} wide>
      <div className="stack" style={{ gap: "1rem" }}>
        <dl className="kv">
          <dt>Legal name</dt><dd>{org.legalName ?? "—"}</dd>
          <dt>TIN</dt><dd className="mono">{org.tin ?? "—"}</dd>
          <dt>Kind</dt><dd>{org.kind === "FLEET" ? "fleet company" : "company account"}</dd>
          <dt>Status</dt><dd><Pill tone={org.status === "VERIFIED" ? "green" : org.status === "PENDING" ? "amber" : "red"}>{org.status.toLowerCase()}</Pill></dd>
        </dl>
        <p className="small muted" style={{ margin: 0 }}>Check that the business licence and TIN certificate name <strong>{org.legalName ?? org.name}</strong> and the TIN above.</p>
        <DocumentChecklist surface="staff" subjectType="ORGANIZATION" subjectId={org.id} mode="staff" canReview={allowed(staff.principal, "document:review", { cityId })} />
        {org.status === "PENDING" && canVerify ? (
          <div className="stack" style={{ gap: "0.5rem" }}>
            {missing.length ? <Notice>Approve the {missing.map((k) => KIND_LABEL[k]?.toLowerCase() ?? k).join(" and ")} first.</Notice> : null}
            <div><button className="btn" disabled={verifying || missing.length > 0} onClick={onVerify}>Verify {org.name}</button></div>
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
