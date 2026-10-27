import { describe, expect, it } from "vitest";
import { backupCodesText, deviceLabel, nameProblem, normalizeBackupCode, orderSessions, passwordProblem } from "../src/lib/account";

describe("my account: profile and password rules", () => {
  it("names are 2–120 characters after trimming", () => {
    expect(nameProblem("  Selam Tesfaye ")).toBeNull();
    expect(nameProblem(" S ")).toMatch(/2 characters/);
    expect(nameProblem("x".repeat(121))).toMatch(/120/);
  });

  it("a new password is 12–128 characters, differs from the current one and is typed twice", () => {
    expect(passwordProblem("old password 1", "short", "short")).toMatch(/12 characters/);
    expect(passwordProblem("old password 1", "x".repeat(129), "x".repeat(129))).toMatch(/128/);
    expect(passwordProblem("same password!", "same password!", "same password!")).toMatch(/different/);
    expect(passwordProblem("old password 1", "a long new sentence", "a long new sentense")).toMatch(/match/);
    expect(passwordProblem("old password 1", "a long new sentence", "a long new sentence")).toBeNull();
  });
});

describe("backup codes", () => {
  it("tolerates spaces typed or pasted around a code", () => {
    expect(normalizeBackupCode("  abcde-12345 \n")).toBe("abcde-12345");
    expect(normalizeBackupCode("abc de")).toBe("abcde");
  });

  it("copies every code with a short heading, and nothing else", () => {
    const text = backupCodesText(["aaaa-1111", "bbbb-2222"], "selam@anbessa.et", new Date("2026-10-27T08:00:00Z"));
    expect(text.split("\n")).toEqual([
      "Anbessa staff backup codes for selam@anbessa.et",
      "Made 2026-10-27. Each code works once. New codes replace these.",
      "",
      "aaaa-1111",
      "bbbb-2222",
      "",
    ]);
    expect(backupCodesText(["c"], null).startsWith("Anbessa staff backup codes\n")).toBe(true);
  });
});

describe("sessions", () => {
  it("names devices people recognise", () => {
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Edge on Windows");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Safari on macOS");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("curl/8.0")).toBe("Unknown device");
  });

  it("lists this browser first, then the most recently active", () => {
    const s = (token: string, updatedAt: string) => ({ token, updatedAt });
    const ordered = orderSessions([s("a", "2026-10-27T08:00:00Z"), s("b", "2026-10-27T09:00:00Z"), s("me", "2026-10-27T07:00:00Z")], "me");
    expect(ordered.map((x) => x.token)).toEqual(["me", "b", "a"]);
  });
});
