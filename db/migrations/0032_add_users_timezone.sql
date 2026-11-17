-- IANA timezone for local-day nudges (e.g. Europe/Amsterdam). NULL → treat as UTC.
ALTER TABLE users ADD COLUMN timezone TEXT;
