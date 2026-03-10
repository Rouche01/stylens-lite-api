-- Migration: Add has_reached_limit to subscriptions table
-- Description: Adds a persistent boolean (integer) column to cache whether a user has reached their session limit.

-- We have to recreate the table because SQLite does not support adding constraints like DEFAULT to existing tables via ALTER TABLE easily,
-- but since this is still early development and we just created the table in the previous migration, we can safely drop and recreate 
-- it, or we can use the standard SQLite approach to add a column with a default value.
-- Actually, SQLite DOES support ADD COLUMN with a DEFAULT value!

ALTER TABLE subscriptions ADD COLUMN has_reached_limit INTEGER DEFAULT 0 NOT NULL;
