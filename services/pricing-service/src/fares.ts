// Fares (workflow 15). The fare card per city and vehicle type is the approved fare rule in force
// (pricing-service's own maker–checker change requests, src/rules/), else the live `fares.*`
// settings (admin dashboard → Settings → Fares, sensitive: a second super admin approves). The
// price is a pure function of that card, the route and the zones, so a quote can always be explained.

import { settingDef, type SettingsReader } from "@ride-app/shared-settings";

export interface FareCard {
  baseMinor: number;
  perKmMinor: number;
  perMinMinor: number;
  minFareMinor: number;
  waitingPerMinMinor: number;
}

export interface FareBreakdown {
  baseMinor: number;
  distanceMinor: number;
  timeMinor: number;
  /** raised to the minimum fare */
  minimumApplied: boolean;
  /** rounded to whole birr, like a meter shows */
  roundingMinor: number;
  /** SURGE zone at the pickup (1 = none) */
  surgeMultiplier: number;
  /** AIRPORT zone fee, added after the minimum fare (0 = none) */
  zoneFeeMinor: number;
}

/** What zones add to a fare (see catalog.ts `zoneEffect`). */
export interface FareAdjustments {
  surgeMultiplier?: number;
  zoneFeeMinor?: number;
}

/** The card for a vehicle type in a city, or null when the type has no fares. */
export function fareCard(settings: SettingsReader, vehicleType: string, cityId: string): FareCard | null {
  const key = (part: string) => `fares.${vehicleType}.${part}`;
  if (!settingDef(key("baseMinor"))) return null;
  return {
    baseMinor: settings.get<number>(key("baseMinor"), cityId),
    perKmMinor: settings.get<number>(key("perKmMinor"), cityId),
    perMinMinor: settings.get<number>(key("perMinMinor"), cityId),
    minFareMinor: settings.get<number>(key("minFareMinor"), cityId),
    waitingPerMinMinor: settings.get<number>(key("waitingPerMinMinor"), cityId),
  };
}

/**
 * (base + km × per-km + minutes × per-minute) × surge, rounded to whole birr, at least the
 * minimum, plus any airport fee.
 */
export function price(card: FareCard, route: { distanceMeters: number; durationSeconds: number }, adj: FareAdjustments = {}): { fareMinor: number; breakdown: FareBreakdown } {
  const surgeMultiplier = adj.surgeMultiplier ?? 1;
  const zoneFeeMinor = adj.zoneFeeMinor ?? 0;
  const distanceMinor = Math.round((route.distanceMeters / 1000) * card.perKmMinor);
  const timeMinor = Math.round((route.durationSeconds / 60) * card.perMinMinor);
  const raw = Math.round((card.baseMinor + distanceMinor + timeMinor) * surgeMultiplier);
  const rounded = Math.round(raw / 100) * 100;
  const metered = Math.max(card.minFareMinor, rounded);
  return {
    fareMinor: metered + zoneFeeMinor,
    breakdown: {
      baseMinor: card.baseMinor, distanceMinor, timeMinor,
      minimumApplied: metered > rounded, roundingMinor: rounded - raw,
      surgeMultiplier, zoneFeeMinor,
    },
  };
}
