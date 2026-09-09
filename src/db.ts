import { Pool } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_bytes BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  progress_tier INT,
  progress_total INT,
  variants JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  attempt INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);
`;

export async function migrate(): Promise<void> {
  await pool.query(MIGRATIONS);
}
