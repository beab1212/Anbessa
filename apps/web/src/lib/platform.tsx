// platform-service's public client configuration: cities, vehicle types, feature flags, the
// maintenance switch and announcements (all set in Administration).

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { http } from "./api";
import { applyCities } from "./format";

export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning";
  audiences: string[];
  cities: string[];
}

export interface ClientConfig {
  version: number;
  cities: { id: string; name: string; timezone: string; bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number } }[];
  vehicleTypes: { code: string; name: string; seatsMin: number; seatsMax: number; cities: string[] }[];
  features: { phoneBooking: boolean; corporateBooking: boolean; tripPin: boolean };
  maintenance: { newTripsPaused: boolean; message: string };
  announcements: Announcement[];
}

const Ctx = createContext<ClientConfig | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const q = useQuery({
    queryKey: ["client-config"],
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async () => {
      const cfg = (await http.get<ClientConfig>("/api/platform/client-config")).data;
      applyCities(cfg.cities);
      return cfg;
    },
  });
  // until it loads (or if platform-service is down) the app runs on its built-in defaults
  return <Ctx.Provider value={q.data ?? null}>{children}</Ctx.Provider>;
}

export const useClientConfig = () => useContext(Ctx);
