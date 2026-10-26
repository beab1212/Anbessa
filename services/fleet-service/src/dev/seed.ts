// Development data for the onboarding queue and the fleet portal.
//
//   pnpm --filter @ride-app/fleet-service seed:dev
//
// Needs auth-service running with DEV_LOGIN=on and its `seed:dev` done: the accounts and
// organisations come from GET /api/dev/accounts. Refuses unless NODE_ENV=development. Creates
// (once; skips anyone already seeded) driver applications, cars and documents. The documents are
// small generated PDFs that say "development sample".

import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { loadConfig } from "../config/index.js";
import { createContainer } from "../container.js";
import type { Db } from "../db.js";
import { authClient } from "../lib/clients.js";
import { piiCrypto } from "../lib/crypto.js";
import type { LocalStore, ObjectStore } from "../lib/storage.js";
import { DOCUMENT_KINDS, EXPIRING_KINDS, type DocumentKind, type SubjectType } from "../fleet/rules.js";
import { serviceLogger } from "../utils/logger.js";

const CITY = "addis-ababa";

/** A one-page PDF with a few lines of text (enough for a reviewer's viewer). */
function samplePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = ["BT", "/F1 22 Tf", "60 760 Td", "28 TL", ...lines.map((l, i) => `${i === 0 ? "" : "T* "}(${esc(l)}) Tj`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const KIND_TITLE: Record<DocumentKind, string> = {
  LICENSE: "Driving licence", NATIONAL_ID: "National ID (Fayda)", PHOTO: "Driver photo", REGISTRATION: "Vehicle registration (libre)",
  INSURANCE: "Insurance certificate", INSPECTION: "Annual inspection", BUSINESS_LICENSE: "Business licence", TIN: "TIN certificate",
};

async function putFile(store: ObjectStore, key: string, body: Buffer) {
  if ((store as Partial<LocalStore>).local) return (store as LocalStore).write(key, body);
  const put = await store.presignPut(key, "application/pdf", body.length);
  const res = await fetch(put.url, { method: "PUT", headers: put.headers, body });
  if (!res.ok) throw new Error(`upload to object storage failed: ${res.status}`);
}

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV !== "development") throw new Error(`seed:dev only runs with NODE_ENV=development (got ${config.NODE_ENV})`);

  const res = await fetch(new URL("/api/dev/accounts", config.AUTH_INTERNAL_URL)).catch(() => null);
  if (!res?.ok) throw new Error("auth-service's /api/dev/accounts isn't available: start auth-service with DEV_LOGIN=on and run its seed:dev first");
  const dev = (await res.json()) as { accounts: { key: string; name: string; userId: string | null }[]; orgs: { slug: string; id: string }[] };
  const user = (key: string) => {
    const a = dev.accounts.find((x) => x.key === key);
    if (!a?.userId) throw new Error(`dev account ${key} isn't seeded: run auth-service's seed:dev`);
    return a;
  };
  const org = (slug: string) => {
    const o = dev.orgs.find((x) => x.slug === slug);
    if (!o) throw new Error(`dev organisation ${slug} isn't seeded: run auth-service's seed:dev`);
    return o.id;
  };

  const c = createContainer(config, serviceLogger(config.NODE_ENV, "warn"));
  const auth = authClient(config.AUTH_INTERNAL_URL, config.INTERNAL_SERVICE_TOKEN);
  const pii = piiCrypto(config.PII_ENCRYPTION_KEY, config.PII_BLIND_INDEX_KEY);
  const db: Db = c.db;
  const inAYear = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 5, 30));
  const done: string[] = [];

  async function documents(subjectType: SubjectType, subjectId: string, owner: string, uploadedBy: string, status: "PENDING" | "APPROVED") {
    for (const kind of DOCUMENT_KINDS[subjectType]) {
      const body = samplePdf(["DEVELOPMENT SAMPLE - not a real document", KIND_TITLE[kind], owner, `Valid until ${inAYear.toISOString().slice(0, 10)}`]);
      const key = `${subjectType.toLowerCase()}/${subjectId}/${kind.toLowerCase()}/${uuidv7()}.pdf`;
      await putFile(c.store, key, body);
      await db.document.create({
        data: {
          subjectType, subjectId, kind, objectKey: key, contentType: "application/pdf", sizeBytes: body.length,
          sha256: new Uint8Array(createHash("sha256").update(body).digest()), expiresAt: EXPIRING_KINDS.includes(kind) ? inAYear : null,
          status, cityId: CITY, uploadedBy, ...(status === "APPROVED" ? { reviewedBy: uploadedBy, reviewedAt: new Date() } : {}),
        },
      });
    }
  }

  async function driver(key: string, licence: string, status: "PENDING_REVIEW" | "ACTIVE") {
    const a = user(key);
    if (await db.driverProfile.findUnique({ where: { userId: a.userId! } })) return false;
    await db.driverProfile.create({
      data: {
        userId: a.userId!, fullName: a.name, licenseNumber: pii.encrypt(licence), licenseHash: pii.blindIndex(licence), licenseLast4: licence.slice(-4),
        cityId: CITY, status, submittedAt: new Date(Date.now() - 3 * 3600_000), ...(status === "ACTIVE" ? { activatedAt: new Date() } : {}),
      },
    });
    await documents("DRIVER", a.userId!, a.name, a.userId!, status === "ACTIVE" ? "APPROVED" : "PENDING");
    if (status === "ACTIVE") await auth.setDriverRole(a.userId!, true);
    done.push(`driver ${a.name} (${status.toLowerCase().replace("_", " ")})`);
    return true;
  }

  async function vehicle(plate: string, owner: { userId?: string; orgId?: string }, by: string, ownerName: string, status: "PENDING_REVIEW" | "VERIFIED", car: { make: string; model: string; year: number; color: string; vehicleType: string; seats: number }) {
    if (await db.vehicle.findUnique({ where: { plateNumber: plate } })) return null;
    const v = await db.vehicle.create({
      data: {
        plateNumber: plate, ownerType: owner.userId ? "INDIVIDUAL" : "ORGANIZATION", ownerUserId: owner.userId ?? null, ownerOrgId: owner.orgId ?? null,
        ...car, cityId: CITY, status, submittedAt: new Date(Date.now() - 2 * 3600_000), ...(status === "VERIFIED" ? { verifiedAt: new Date() } : {}),
      },
    });
    await documents("VEHICLE", v.id, `${ownerName} - ${plate}`, by, status === "VERIFIED" ? "APPROVED" : "PENDING");
    done.push(`vehicle ${plate} (${status.toLowerCase().replace("_", " ")})`);
    return v;
  }

  async function orgDocuments(orgId: string, name: string, by: string, status: "PENDING" | "APPROVED") {
    if (await db.document.findFirst({ where: { subjectType: "ORGANIZATION", subjectId: orgId } })) return;
    await documents("ORGANIZATION", orgId, name, by, status);
    done.push(`${name} company documents (${status.toLowerCase()})`);
  }

  try {
    const fleet = org("dev-fleet");
    const corporate = org("dev-corporate");
    const owner = user("fleet-owner");

    // waiting for review: an owner-driver and their car
    const applicant = user("driver-applicant");
    await driver("driver-applicant", "AA204401", "PENDING_REVIEW");
    await vehicle("3-A40401", { userId: applicant.userId! }, applicant.userId!, applicant.name, "PENDING_REVIEW", { make: "Toyota", model: "Vitz", year: 2016, color: "Silver", vehicleType: "economy", seats: 4 });

    // approved owner-driver with their car
    const active = user("driver-active");
    await driver("driver-active", "AA204402", "ACTIVE");
    await vehicle("3-A40402", { userId: active.userId! }, active.userId!, active.name, "VERIFIED", { make: "Hyundai", model: "Atos", year: 2019, color: "Blue", vehicleType: "economy", seats: 4 });

    // the fleet: documents approved, one verified car given to its driver, one car waiting for review
    await orgDocuments(fleet, "Selam Transport PLC", owner.userId!, "APPROVED");
    await driver("fleet-driver", "AA201002", "ACTIVE");
    const shared = await vehicle("3-B10201", { orgId: fleet }, owner.userId!, "Selam Transport PLC", "VERIFIED", { make: "Toyota", model: "Corolla", year: 2020, color: "White", vehicleType: "comfort", seats: 4 });
    if (shared) {
      await db.vehicleAuthorization.create({ data: { vehicleId: shared.id, driverUserId: user("fleet-driver").userId!, grantedBy: owner.userId! } });
    }
    await vehicle("3-B10202", { orgId: fleet }, owner.userId!, "Selam Transport PLC", "PENDING_REVIEW", { make: "Toyota", model: "HiAce", year: 2017, color: "White", vehicleType: "minivan", seats: 7 });

    // the company account's documents wait for the onboarding officer
    await orgDocuments(corporate, "Abay Bank S.C.", user("corporate-admin").userId!, "PENDING");
  } finally {
    await c.close();
  }

  process.stdout.write(done.length ? `fleet dev data:\n${done.map((d) => `  ${d}`).join("\n")}\n` : "fleet dev data already there (nothing to do)\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
