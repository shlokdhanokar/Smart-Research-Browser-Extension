-- Runs once when the Postgres container is created (empty data dir).
-- Enables pgvector and allows the app user to create tables (captured_pages).

\connect hindsite_db

CREATE EXTENSION IF NOT EXISTS vector;

GRANT CREATE ON SCHEMA public TO hindsite_user;
