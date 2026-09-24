-- Initial prototype schema. No destructive or implicit upgrades.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
-- Only set the initial schema version for a new database.
