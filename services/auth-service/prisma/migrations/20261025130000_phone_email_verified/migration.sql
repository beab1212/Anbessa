-- Placeholder emails (<digits>@phone.anbessa.invalid) are derived from the phone number,
-- so a verified phone means a verified placeholder email. Better Auth requires a
-- verified email to list and accept organisation invitations (Auth.md §17, I4).
UPDATE "app_user"
SET "email_verified" = true
WHERE "phone_number_verified" = true
  AND "email_verified" = false
  AND "email" = substr("phone_number", 2) || '@phone.anbessa.invalid';
