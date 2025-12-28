#!/bin/bash

MIGRATIONS_DIR="./db/migrations"
ENV=${2:-local}  # default to local if not specified

# Function to list available migrations
list_migrations() {
  echo "📋 Available migrations:"
  if [ -d "$MIGRATIONS_DIR" ]; then
    ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | while read -r file; do
      echo "  - $(basename "$file")"
    done
  else
    echo "  No migrations directory found"
  fi
}

# Function to get the latest migration
get_latest_migration() {
  ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort -V | tail -n 1
}

# Function to apply migration
apply_migration() {
  local migration_file=$1
  local env=$2

  if [ "$env" = "local" ]; then
    echo "🔄 Applying migration locally: $(basename "$migration_file")"
    wrangler d1 execute gostylens_db --local --file="$migration_file"
  elif [ "$env" = "remote" ]; then
    echo "🔄 Applying migration remotely: $(basename "$migration_file")"
    wrangler d1 execute gostylens_db --remote --file="$migration_file"
  else
    echo "❌ Error: Invalid environment. Use 'local' or 'remote'"
    exit 1
  fi
}

# Parse command
COMMAND=$1

case "$COMMAND" in
  list|ls)
    list_migrations
    ;;

  latest)
    LATEST=$(get_latest_migration)
    if [ -z "$LATEST" ]; then
      echo "❌ Error: No migration files found in $MIGRATIONS_DIR"
      exit 1
    fi
    apply_migration "$LATEST" "$ENV"
    echo "✅ Migration applied successfully!"
    ;;

  all)
    if [ ! -d "$MIGRATIONS_DIR" ] || [ -z "$(ls -A "$MIGRATIONS_DIR"/*.sql 2>/dev/null)" ]; then
      echo "❌ Error: No migration files found in $MIGRATIONS_DIR"
      exit 1
    fi

    echo "🔄 Applying all migrations in order..."
    for file in $(ls -1 "$MIGRATIONS_DIR"/*.sql | sort -V); do
      apply_migration "$file" "$ENV"
    done
    echo "✅ All migrations applied successfully!"
    ;;

  "")
    echo "❌ Error: Please provide a command"
    echo ""
    echo "Usage:"
    echo "  npm run db:migrate list [local|remote]                    # List available migrations"
    echo "  npm run db:migrate latest [local|remote]                  # Apply latest migration"
    echo "  npm run db:migrate all [local|remote]                     # Apply all migrations"
    echo "  npm run db:migrate <migration-name> [local|remote]        # Apply specific migration"
    echo "  npm run db:migrate <migration-file-path> [local|remote]   # Apply migration by path"
    echo ""
    echo "Examples:"
    echo "  npm run db:migrate list"
    echo "  npm run db:migrate latest local"
    echo "  npm run db:migrate all remote"
    echo "  npm run db:migrate 0002_add_soft_delete.sql local"
    echo "  npm run db:migrate ./db/migrations/0002_add_soft_delete.sql remote"
    exit 1
    ;;

  *)
    # Check if it's a file path
    if [ -f "$COMMAND" ]; then
      MIGRATION_FILE="$COMMAND"
    # Check if it's a migration name in the migrations directory
    elif [ -f "$MIGRATIONS_DIR/$COMMAND" ]; then
      MIGRATION_FILE="$MIGRATIONS_DIR/$COMMAND"
    else
      echo "❌ Error: Migration file not found: $COMMAND"
      echo ""
      list_migrations
      exit 1
    fi

    apply_migration "$MIGRATION_FILE" "$ENV"
    echo "✅ Migration applied successfully!"
    ;;
esac