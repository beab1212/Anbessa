#!/usr/bin/env bash
# scripts/setup.sh — full environment setup for new contributors
# You can also use the targeted `make setup-<team>` commands instead.
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

log()  { echo -e "${BOLD}→ $1${RESET}"; }
ok()   { echo -e "${GREEN}✔  $1${RESET}"; }
warn() { echo -e "${YELLOW}⚠  $1${RESET}"; }

# ── Node / pnpm ──────────────────────────────────────────────────────────────
log "Checking Node.js..."
node_version=$(node -v 2>/dev/null | cut -c2- | cut -d. -f1 || echo 0)
if [ "$node_version" -lt 20 ]; then
  warn "Node ≥20 required. Install via nvm: nvm install"
  exit 1
fi
ok "Node $(node -v)"

if ! command -v pnpm &>/dev/null; then
  log "Installing pnpm..."
  npm install -g pnpm@9
fi
ok "pnpm $(pnpm -v)"

# ── Services deps ─────────────────────────────────────────────────────────────
log "Installing Node workspace dependencies..."
pnpm install
ok "Node deps installed"

# ── Flutter / Melos ───────────────────────────────────────────────────────────
if command -v flutter &>/dev/null; then
  log "Installing Flutter workspace dependencies (Melos)..."
  command -v melos &>/dev/null || dart pub global activate melos
  melos bootstrap
  ok "Flutter deps installed"
else
  warn "Flutter not found — skipping mobile setup."
  warn "Install at: https://docs.flutter.dev/get-started/install"
fi

# ── Docker infra ──────────────────────────────────────────────────────────────
if command -v docker &>/dev/null; then
  log "Starting local infrastructure (postgres, redis, redpanda, kong)..."
  docker compose -f infra/docker/docker-compose.yml up -d
  log "Waiting for Postgres..."
  until docker compose -f infra/docker/docker-compose.yml exec -T postgres \
    pg_isready -U ride -d ride_app >/dev/null 2>&1; do sleep 1; done
  ok "Postgres ready"
else
  warn "Docker not found — skipping infra startup."
  warn "Install Docker Desktop: https://www.docker.com/products/docker-desktop"
fi

# ── Env files ─────────────────────────────────────────────────────────────────
log "Copying .env.example → .env for each service..."
for svc in services/*/; do
  if [ -f "$svc.env.example" ] && [ ! -f "$svc.env" ]; then
    cp "$svc.env.example" "$svc.env"
    echo "  created $svc.env"
  fi
done
[ -f apps/admin-dashboard/.env.example ] && \
  cp -n apps/admin-dashboard/.env.example apps/admin-dashboard/.env 2>/dev/null || true
ok "Env files ready"

# ── DB migrations ─────────────────────────────────────────────────────────────
if command -v docker &>/dev/null; then
  log "Running Prisma migrations..."
  for svc in auth-service trip-service payment-service; do
    pnpm --filter @ride-app/"$svc" prisma migrate dev --name init 2>/dev/null || \
    pnpm --filter @ride-app/"$svc" prisma migrate deploy
    echo "  migrated $svc"
  done
  ok "Migrations complete"
fi

echo ""
echo -e "${BOLD}All done! Next steps:${RESET}"
echo "  Backend team   → make dev-services"
echo "  Mobile team    → make dev-mobile"
echo "  Admin team     → make dev-admin"
echo "  Infra team     → make infra-up"
echo ""
echo "  Run 'make help' to see all available commands."
