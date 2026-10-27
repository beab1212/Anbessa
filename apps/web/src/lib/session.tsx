import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { setAuthzSnapshot, type AuthzSnapshot, type Principal } from "@ride-app/shared-authz";
import { accessToken, api, authCall, forgetTokens, principalOf, type Claims, type Surface } from "./api";

interface SurfaceState {
  loading: boolean;
  principal: Principal | null;
  claims: Claims | null;
}

interface SessionValue {
  staff: SurfaceState;
  partner: SurfaceState;
  refresh(surface: Surface): Promise<void>;
  signOut(surface: Surface): Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

/** Public pages (a shared trip, /t/:token) need no session: visitors have none, so don't ask. */
const onPublicPage = () => typeof window !== "undefined" && window.location.pathname.startsWith("/t/");

/** Who is signed in on each surface: a fresh access token's claims, refreshed with the token. */
function useClaims(surface: Surface) {
  return useQuery({
    queryKey: ["session", surface],
    enabled: !onPublicPage(),
    queryFn: async () => {
      const t = await accessToken(surface, true).catch(() => null);
      return { claims: t?.claims ?? null };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * The live permission matrix (auth-service, edited in Administration → Roles and permissions).
 * The bundled matrix is only the fallback; the roles in a token are read against this one,
 * so custom roles and permission changes show up without a new release.
 */
function useAuthz(surface: Surface | null) {
  return useQuery({
    queryKey: ["authz", surface],
    enabled: !!surface,
    refetchInterval: 60_000,
    queryFn: async () => {
      const snap = await api<AuthzSnapshot>(surface!, "/api/identity/authz");
      setAuthzSnapshot(snap);
      return snap.version;
    },
  });
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const staffQ = useClaims("staff");
  const partnerQ = useClaims("partner");
  const staffClaims = staffQ.data?.claims ?? null;
  const partnerClaims = partnerQ.data?.claims ?? null;
  const authz = useAuthz(staffClaims ? "staff" : partnerClaims ? "partner" : null);
  const version = authz.data;
  const staff = useMemo<SurfaceState>(
    () => ({ loading: staffQ.isLoading || (!!staffClaims && authz.isLoading), claims: staffClaims, principal: staffClaims ? principalOf("staff", staffClaims) : null }),
    // the principal is re-read when the matrix version changes (custom roles become known)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staffQ.isLoading, staffClaims, authz.isLoading, version],
  );
  const partner = useMemo<SurfaceState>(
    () => ({ loading: partnerQ.isLoading, claims: partnerClaims, principal: partnerClaims ? principalOf("partner", partnerClaims) : null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [partnerQ.isLoading, partnerClaims, version],
  );

  const refresh = useCallback(async (surface: Surface) => {
    forgetTokens(surface);
    await qc.refetchQueries({ queryKey: ["session", surface] });
  }, [qc]);

  const signOut = useCallback(async (surface: Surface) => {
    await authCall(surface, "/sign-out", {}).catch(() => undefined);
    forgetTokens(surface);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
    qc.setQueryData(["session", surface], { claims: null, principal: null });
  }, [qc]);

  const value = useMemo(() => ({ staff, partner, refresh, signOut }), [staff, partner, refresh, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}
