-- Maker-checker for large campaigns: a second staff member approves before sending.
ALTER TABLE "campaign" ADD COLUMN "approved_by" UUID;
ALTER TABLE "campaign" ADD COLUMN "approved_at" TIMESTAMPTZ;

ALTER TABLE "campaign" DROP CONSTRAINT ck_campaign_status;
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_status CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED'));
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_awaiting_approval CHECK (status <> 'AWAITING_APPROVAL' OR scheduled_at IS NOT NULL);
-- the approver is never the maker
ALTER TABLE "campaign" ADD CONSTRAINT ck_campaign_approver CHECK (approved_by IS NULL OR (approved_by <> created_by));
