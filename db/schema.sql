-- Phase 1: no D1 tables yet (all state is in KV + localStorage)
-- Phase 2 schema — run via: wrangler d1 execute whatthesub-db --file=db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER DEFAULT 0,
  unlimited_play INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_results (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id),
  puzzle_date   TEXT NOT NULL,
  status        TEXT NOT NULL,  -- 'won' | 'lost'
  strikes       INTEGER DEFAULT 0,
  rounds_won    INTEGER DEFAULT 0,
  duration_sec  INTEGER,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, puzzle_date)
);

CREATE TABLE IF NOT EXISTS round_guesses (
  id              TEXT PRIMARY KEY,
  result_id       TEXT REFERENCES game_results(id),
  round           INTEGER,
  correct_sub     TEXT,
  guessed_sub     TEXT,
  correct         INTEGER,
  attempt_num     INTEGER
);

CREATE TABLE IF NOT EXISTS friends (
  id            TEXT PRIMARY KEY,
  requester_id  TEXT REFERENCES users(id),
  addressee_id  TEXT REFERENCES users(id),
  status        TEXT DEFAULT 'pending',
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  user_id TEXT REFERENCES users(id),
  flag    TEXT NOT NULL,
  value   INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, flag)
);

-- Phase 3: Find the Thread game results
CREATE TABLE IF NOT EXISTS thread_results (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id),
  puzzle_date  TEXT NOT NULL,
  status       TEXT NOT NULL,  -- 'won' | 'lost'
  strikes      INTEGER DEFAULT 0,
  groups_found INTEGER DEFAULT 0,
  duration_sec INTEGER,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, puzzle_date)
);
