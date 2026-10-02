-- One row per activity summary sent by RunReader. Never GPS or per-second series:
-- the app filters fields in src/services/activitySummary.ts before sending.
CREATE TABLE IF NOT EXISTS activities (
  sync_key TEXT PRIMARY KEY,
  start_time TEXT NOT NULL,
  sport_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_start ON activities (start_time);

-- Workouts Claude plans for the athlete (plan_workout tool); the app shows the upcoming ones
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  workout TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_date ON plans (date);

-- Advice Claude leaves for the athlete (save_advice); the app shows the latest
CREATE TABLE IF NOT EXISTS advice (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Small settings the app pushes, e.g. the athlete's goal (key 'goal')
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
