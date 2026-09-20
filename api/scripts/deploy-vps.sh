#!/usr/bin/env bash
#
# deploy-vps.sh - copy this project into the production layout used on an
# Apache VPS (or a cPanel "public_html/tams" root) and optionally restart
# Apache. Run it ON the server from a clone of the repo after `git pull`.
#
# Layout produced (see api/scripts/VPS_DEPLOYMENT_SETUP.md):
#   $TARGET/index.php   # from front-end/
#   $TARGET/.htaccess   # from front-end/
#   $TARGET/public/     # from front-end/public/
#   $TARGET/src/        # from front-end/src/
#   $TARGET/scripts/    # from front-end/scripts/
#   $TARGET/api/        # the complete api/ directory
#
# Server-side state is PRESERVED: api/logs, api/cache, api/uploads, and the
# gitignored private files (api/config/private-mail.php,
# api/config/private-security.php) are never
# deleted or overwritten by this script.
#
# Usage:
#   ./deploy-vps.sh [TARGET] [--reload] [--composer]
#
# Examples:
#   ./deploy-vps.sh                        # copy to /var/www/tams
#   ./deploy-vps.sh --reload               # copy to /var/www/tams and reload Apache
#   ./deploy-vps.sh --composer --reload    # also run composer install
#   ./deploy-vps.sh /tmp/stage             # copy somewhere else
#   TAMS_DEPLOY_DIR=/var/www/tams ./deploy-vps.sh --reload

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FE="$REPO_ROOT/front-end"
SRC_API="$REPO_ROOT/api"

TARGET="${TAMS_DEPLOY_DIR:-/var/www/tams}"
DO_RELOAD=0
DO_COMPOSER=0

for arg in "$@"; do
  case "$arg" in
    --reload)   DO_RELOAD=1 ;;
    --composer) DO_COMPOSER=1 ;;
    --help|-h)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *) TARGET="$arg" ;;
  esac
done

command -v rsync >/dev/null 2>&1 || { echo "rsync is required. Install it: sudo apt install -y rsync"; exit 1; }
[ -d "$FE" ] || { echo "Missing frontend directory: $FE"; exit 1; }
[ -d "$SRC_API" ] || { echo "Missing api directory: $SRC_API"; exit 1; }
[ -f "$FE/index.php" ] || { echo "Missing $FE/index.php"; exit 1; }

echo "Deploying from : $REPO_ROOT"
echo "Target         : $TARGET"

install -d "$TARGET" "$TARGET/public" "$TARGET/src" "$TARGET/scripts" "$TARGET/api"
install -d "$TARGET/api/logs" "$TARGET/api/cache" "$TARGET/api/uploads"

# Frontend entry points
cp -f "$FE/index.php" "$TARGET/index.php"
cp -f "$FE/.htaccess" "$TARGET/.htaccess"

# Static/public, runtime src, and build-time scripts (safe to delete stale files)
rsync -a --delete "$FE/public/"  "$TARGET/public/"
rsync -a --delete "$FE/src/"     "$TARGET/src/"
rsync -a --delete "$FE/scripts/" "$TARGET/scripts/"

# API: sync everything while keeping server-side runtime/private state intact.
rsync -a --delete \
  --exclude 'logs/' \
  --exclude 'cache/' \
  --exclude 'uploads/' \
  --exclude 'config/private-mail.php' \
  --exclude 'config/private-security.php' \
  "$SRC_API/" "$TARGET/api/"

echo "Files synced."

if [ "$DO_COMPOSER" -eq 1 ]; then
  echo "Running composer install (Web Push patch included)..."
  ( cd "$TARGET/api" && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --prefer-dist )
fi

echo "Applying ownership on writable folders..."
chown -R www-data:www-data "$TARGET/api/logs" "$TARGET/api/cache" "$TARGET/api/uploads" 2>/dev/null || true
chmod -R u+rwX,g+rwX,o+rX "$TARGET/api/logs" "$TARGET/api/cache" "$TARGET/api/uploads" 2>/dev/null || true

if [ "$DO_RELOAD" -eq 1 ]; then
  echo "Testing Apache config and reloading..."
  apache2ctl configtest || { echo "Apache config test failed; not reloading."; exit 1; }
  systemctl reload apache2
fi

echo
echo "Deploy complete -> $TARGET"
echo "Reminders:"
echo "  * API_BASE is auto-derived from the page origin (front-end/public/index.html)."
echo "  * Confirm the .htaccess rules are still honored (AllowOverride All)."
echo "  * Verify at your HTTPS URL once it is live."
