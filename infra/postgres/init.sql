-- Runs once, when the Postgres volume is first created.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE DATABASE opsilume_test OWNER opsilume;
\connect opsilume_test
CREATE EXTENSION IF NOT EXISTS vector;
