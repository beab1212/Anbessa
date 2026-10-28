-- Staff status-change notes on a lost-item report are internal (staff only) unless shared.
ALTER TABLE "lost_item_message" ADD COLUMN "internal" BOOLEAN NOT NULL DEFAULT false;
