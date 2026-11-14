CREATE TABLE "acquisition_players" (
    "id" UUID PRIMARY KEY,
    "first_seen_at" TIMESTAMPTZ NOT NULL,
    "existing_player" BOOLEAN NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "medium" VARCHAR(100) NOT NULL,
    "campaign" VARCHAR(100),
    "content" VARCHAR(100)
);

CREATE TABLE "acquisition_runs" (
    "player_id" UUID NOT NULL REFERENCES "acquisition_players"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "run_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ,
    "rhythm_12_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    PRIMARY KEY ("player_id", "run_id")
);
