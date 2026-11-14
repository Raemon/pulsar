CREATE TABLE "marketing_expenses" (
    "expense_id" TEXT PRIMARY KEY CHECK (length(expense_id) BETWEEN 1 AND 255),
    -- NULL covers shared costs such as setting up the acquisition measurement.
    "campaign" TEXT CHECK (campaign IS NULL OR length(campaign) BETWEEN 1 AND 100),
    "category" TEXT NOT NULL CHECK (category IN ('compute', 'media', 'creative', 'tools', 'other')),
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "amount_usd" DECIMAL(26,12),
    "basis" TEXT NOT NULL CHECK (basis IN ('actual', 'estimate', 'unknown')),
    "details" JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
    CHECK ((amount_usd IS NULL) = (basis = 'unknown'))
);
CREATE INDEX "marketing_expenses_campaign_time" ON "marketing_expenses" (campaign, occurred_at);
