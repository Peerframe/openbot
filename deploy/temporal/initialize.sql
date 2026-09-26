-- PostgreSQL entrypoint executes this only when creating the profile's new empty volume.
-- psql's literal quoting handles the password; never interpolate it as SQL source.
\getenv runtime_password OPENBOT_TEMPORAL_RUNTIME_PASSWORD
CREATE ROLE temporal_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE temporal OWNER temporal_schema;
CREATE DATABASE temporal_visibility OWNER temporal_schema;
REVOKE ALL ON DATABASE temporal FROM PUBLIC;
REVOKE ALL ON DATABASE temporal_visibility FROM PUBLIC;
GRANT CONNECT ON DATABASE temporal, temporal_visibility TO temporal_runtime;

\connect temporal
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO temporal_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE temporal_schema IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO temporal_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE temporal_schema IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO temporal_runtime;

\connect temporal_visibility
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO temporal_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE temporal_schema IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO temporal_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE temporal_schema IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO temporal_runtime;
