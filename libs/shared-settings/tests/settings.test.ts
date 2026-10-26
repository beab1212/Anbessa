import { describe, expect, it } from "vitest";
import { resolveSetting, SETTINGS, settingDef, staticSettings, validateSetting, type SettingsSnapshot } from "../src/index.js";

describe("settings registry", () => {
  it("every default passes its own validation; keys are unique", () => {
    for (const d of SETTINGS) expect(validateSetting(d.key, d.default), d.key).toMatchObject({ ok: true });
    expect(new Set(SETTINGS.map((d) => d.key)).size).toBe(SETTINGS.length);
  });

  it("checks types and bounds", () => {
    expect(validateSetting("match.offerSeconds", 4)).toMatchObject({ ok: false });
    expect(validateSetting("match.offerSeconds", 20.5)).toMatchObject({ ok: false });
    expect(validateSetting("cancel.driverShare", 1.2)).toMatchObject({ ok: false });
    expect(validateSetting("otp.channels", ["sms", "sms"])).toMatchObject({ ok: false });
    expect(validateSetting("otp.channels", ["sms"])).toMatchObject({ ok: true });
    expect(validateSetting("apps.minVersion.rider.android", "2.x")).toMatchObject({ ok: false });
    expect(validateSetting("match.radiiMeters", [1500, 3000])).toMatchObject({ ok: true });
    expect(validateSetting("no.such.key", 1)).toMatchObject({ ok: false });
    expect(settingDef("cancel.feeMinor")).toMatchObject({ sensitive: true, scope: "city" });
  });

  it("resolves city override → global → service default → registry default", () => {
    const snap: SettingsSnapshot = { version: 3, global: { "cancel.freeSeconds": 90 }, cities: { hawassa: { "cancel.freeSeconds": 60, "match.offerSeconds": 5 } }, cityList: [], vehicleTypes: [] };
    expect(resolveSetting(snap, "cancel.freeSeconds", "hawassa")).toBe(60);
    expect(resolveSetting(snap, "cancel.freeSeconds", "addis-ababa")).toBe(90);
    // global-only settings ignore city overrides
    expect(resolveSetting(snap, "match.offerSeconds", "hawassa")).toBe(15);
    expect(resolveSetting(snap, "match.timeoutSeconds", undefined, { "match.timeoutSeconds": 100 })).toBe(100);
    expect(resolveSetting(snap, "match.timeoutSeconds", undefined)).toBe(120);
  });

  it("static settings can be changed by tests", () => {
    const s = staticSettings({ "trip.pinRequired": true });
    expect(s.get("trip.pinRequired")).toBe(true);
    s.set("cancel.feeMinor", 5000, "addis-ababa");
    expect(s.get("cancel.feeMinor", "addis-ababa")).toBe(5000);
    expect(s.get("cancel.feeMinor", "hawassa")).toBe(3000);
  });
});
