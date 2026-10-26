import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Principal } from "@ride-app/shared-authz";
import { accessToken, authCall, forgetTokens, principalOf, type Claims, type Surface } from "./api";

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

/** Who is signed in on each surface: a fresh access token's claims, refreshed with the token. */
function useSurface(surface: Surface): SurfaceState {
  const q = useQuery({
    queryKey: ["session", surface],
    queryFn: async () => {
      const t = await accessToken(surface, true).catch(() => null);
      return t ? { claims: t.claims, principal: principalOf(surface, t.claims) } : { claims: null, principal: null };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { loading: q.isLoading, claims: q.data?.claims ?? null, principal: q.data?.principal ?? null };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const staff = useSurface("staff");
  const partner = useSurface("partner");

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
