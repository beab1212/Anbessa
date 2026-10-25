// Which Better Auth HTTP endpoints each surface serves (Auth.md §5, S7).
// Everything else — including every /admin/* endpoint of the admin plugin,
// sign-up, social login, organization deletion, roles and teams — returns 404.

type Method = "GET" | "POST";
type Rule = readonly [Method, string];

const APP: readonly Rule[] = [
  ["GET", "/ok"],
  ["GET", "/get-session"],
  ["POST", "/sign-out"],
  ["GET", "/list-sessions"],
  ["POST", "/revoke-session"],
  ["POST", "/revoke-other-sessions"],
  ["POST", "/update-user"], // only input:true fields (name, image) are writable
  ["POST", "/phone-number/send-otp"],
  ["POST", "/phone-number/verify"],
  ["GET", "/token"],
  ["GET", "/jwks"],
  // self-service FLEET / CORPORATE organisations (staff orgs are guarded separately)
  ["POST", "/organization/create"],
  ["GET", "/organization/check-slug"],
  ["POST", "/organization/check-slug"],
  ["GET", "/organization/list"],
  ["GET", "/organization/get-full-organization"],
  ["POST", "/organization/set-active"],
  ["POST", "/organization/update"],
  ["GET", "/organization/get-active-member"],
  ["GET", "/organization/list-members"],
  ["POST", "/organization/invite-member"],
  ["POST", "/organization/cancel-invitation"],
  ["GET", "/organization/get-invitation"],
  ["GET", "/organization/list-invitations"],
  ["GET", "/organization/list-user-invitations"],
  ["POST", "/organization/accept-invitation"],
  ["POST", "/organization/reject-invitation"],
  ["POST", "/organization/remove-member"],
  ["POST", "/organization/update-member-role"],
  ["POST", "/organization/has-permission"],
];

const ADMIN: readonly Rule[] = [
  ["GET", "/ok"],
  ["POST", "/sign-in/email"],
  ["POST", "/sign-out"],
  ["GET", "/get-session"],
  ["GET", "/list-sessions"],
  ["POST", "/revoke-session"],
  ["POST", "/revoke-other-sessions"],
  ["POST", "/change-password"],
  ["GET", "/token"],
  // two-factor enrolment and verification; disabling 2FA is not allowed for staff
  ["POST", "/two-factor/enable"],
  ["POST", "/two-factor/get-totp-uri"],
  ["POST", "/two-factor/verify-totp"],
  ["POST", "/two-factor/verify-backup-code"],
  ["POST", "/two-factor/generate-backup-codes"],
];

const index = (rules: readonly Rule[]) => new Set(rules.map(([m, p]) => `${m} ${p}`));
const APP_SET = index(APP);
const ADMIN_SET = index(ADMIN);

export function isAllowed(surface: "app" | "admin", method: string, path: string): boolean {
  return (surface === "app" ? APP_SET : ADMIN_SET).has(`${method.toUpperCase()} ${path}`);
}

export const allowlists = { app: APP, admin: ADMIN };
