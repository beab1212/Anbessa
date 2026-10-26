# ==============================================================================
# ride-app — Makefile
#
# Run `make help` to see everything available.
# The four team entry points are:
#   make setup-mobile     → Flutter team
#   make setup-services   → Backend team
#   make setup-infra      → DevOps/infra team
#   make setup-web        → Web team (staff dashboard, fleet and corporate portals)
# ==============================================================================

.DEFAULT_GOAL := help
.PHONY: help setup setup-mobile setup-services setup-web setup-infra \
        dev-services dev-mobile dev-web dev-infra \
        stack-up secrets map-data test lint typecheck clean

SHELL := /bin/bash
SERVICES := auth-service trip-service location-service pricing-service \
            payment-service notification-service mapping-service realtime-gateway fleet-service \
            platform-service audit-service
PRISMA_SERVICES := auth-service notification-service trip-service fleet-service payment-service platform-service audit-service

# ── colours ────────────────────────────────────────────────────────────────────
BOLD  := \033[1m
CYAN  := \033[36m
GREEN := \033[32m
RESET := \033[0m

# ── help ───────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "$(BOLD)ride-app — team entry points$(RESET)"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo ""
	@echo "$(CYAN)Initial setup (run once, per team):$(RESET)"
	@echo "  make setup-mobile     Install Flutter deps for the phone app (rider + driver modes)"
	@echo "  make setup-services   Install Node deps + spin up infra containers"
	@echo "  make setup-web        Install Node deps for the web app"
	@echo "  make setup-infra      Bootstrap Terraform + Kubernetes tooling"
	@echo "  make setup            Everything above in one shot"
	@echo "  make secrets          Create .env files + local dev auth secrets (never overwrites)"
	@echo ""
	@echo "$(CYAN)Day-to-day dev:$(RESET)"
	@echo "  make dev-services     Start all services in watch mode (hot reload)"
	@echo "  make dev-mobile       Flutter run the phone app (rider + driver modes)"
	@echo "  make dev-web          Start the web app dev server"
	@echo "  make dev-infra        Start the local mapping stack"
	@echo "  make map-data         Download the OSM extract + build the OSRM graph (once)"
	@echo ""
	@echo "$(CYAN)One service at a time:$(RESET)"
	@echo "  make dev-svc SVC=auth-service"
	@echo "  make test-svc SVC=trip-service"
	@echo "  make logs-svc SVC=payment-service"
	@echo ""
	@echo "$(CYAN)Quality:$(RESET)"
	@echo "  make test             Run all tests (services + Flutter)"
	@echo "  make lint             Lint everything"
	@echo "  make typecheck        TypeScript check across all services"
	@echo ""
	@echo "$(CYAN)Infra:$(RESET)"
	@echo "  make infra-up         Start postgres + redis + redpanda (services run on the host)"
	@echo "  make stack-up         Build + run EVERY service in containers, plus kong on :8000"
	@echo "  make infra-down       Tear it down"
	@echo "  make infra-reset      Tear down, wipe volumes, bring back up"
	@echo "  make db-migrate       Run Prisma migrations for all services"
	@echo "  make db-seed          Seed local database"
	@echo ""

# ── setup ──────────────────────────────────────────────────────────────────────
setup: setup-services setup-mobile setup-web
	@echo "$(GREEN)✔  Full setup complete. See README.md for next steps.$(RESET)"

setup-mobile:
	@echo "$(BOLD)→ Mobile setup$(RESET)"
	@command -v flutter >/dev/null || (echo "Flutter not found. Install: https://docs.flutter.dev/get-started/install" && exit 1)
	dart pub get   # resolves the whole Dart pub workspace (root pubspec.yaml), melos included
	@echo "$(GREEN)✔  Mobile ready. Run: make dev-mobile$(RESET)"

setup-services:
	@echo "$(BOLD)→ Services setup$(RESET)"
	@command -v node >/dev/null || (echo "Node ≥24 required. Install via nvm: nvm install" && exit 1)
	@command -v pnpm >/dev/null || corepack enable   # pnpm version comes from package.json "packageManager"
	pnpm install
	@$(MAKE) --no-print-directory _copy-env-examples
	@$(MAKE) --no-print-directory secrets
	@$(MAKE) --no-print-directory infra-up
	@$(MAKE) --no-print-directory db-migrate
	@echo "$(GREEN)✔  Services ready. Run: make dev-services$(RESET)"

setup-web:
	@echo "$(BOLD)→ Web app setup$(RESET)"
	cd apps/web && pnpm install
	@cp -n apps/web/.env.example apps/web/.env 2>/dev/null || true
	@echo "$(GREEN)✔  Web app ready. Run: make dev-web$(RESET)"

setup-infra:
	@echo "$(BOLD)→ Infra setup$(RESET)"
	@command -v terraform >/dev/null || (echo "Terraform not found: https://developer.hashicorp.com/terraform/install" && exit 1)
	@command -v kubectl   >/dev/null || (echo "kubectl not found: https://kubernetes.io/docs/tasks/tools/" && exit 1)
	cd infra/terraform && terraform init
	@echo "$(GREEN)✔  Infra tooling ready.$(RESET)"

_copy-env-examples:
	@[ -f .env ] || (cp .env.example .env && echo "  created .env (used by infra/docker/docker-compose.yml)")
	@for svc in $(SERVICES); do \
	  if [ ! -f services/$$svc/.env ]; then \
	    cp services/$$svc/.env.example services/$$svc/.env 2>/dev/null && echo "  created services/$$svc/.env" || true; \
	  fi; \
	done

# Generates the key pair only when missing, so existing keys (and every token
# signed with them) survive. umask 077 means the private key is never readable
# by other users, even for the instant between creation and chmod.
secrets:
	@bash scripts/dev-secrets.sh

# Download the OSM extract and build the OSRM routing graph for make dev-infra (one-time, ~10 min)
map-data:
	@bash scripts/map-data.sh

# ── dev ────────────────────────────────────────────────────────────────────────
dev-services: secrets
	pnpm turbo run dev --parallel

dev-svc: secrets
	@[ -n "$(SVC)" ] || (echo "Usage: make dev-svc SVC=auth-service" && exit 1)
	pnpm --filter @ride-app/$(SVC) dev

dev-mobile:
	cd apps/phone-app && flutter run

dev-web:
	cd apps/web && pnpm dev

dev-infra:
	docker compose -f infra/mapping-stack/docker-compose.mapping.yml up

# ── test ───────────────────────────────────────────────────────────────────────
test:
	pnpm turbo run test
	dart run melos run test

test-svc:
	@[ -n "$(SVC)" ] || (echo "Usage: make test-svc SVC=auth-service" && exit 1)
	pnpm --filter @ride-app/$(SVC) test

# ── lint / types ───────────────────────────────────────────────────────────────
lint:
	pnpm turbo run lint
	dart run melos run analyze

typecheck:
	pnpm turbo run typecheck

# ── logs ───────────────────────────────────────────────────────────────────────
logs-svc:
	@[ -n "$(SVC)" ] || (echo "Usage: make logs-svc SVC=auth-service" && exit 1)
	docker compose -f infra/docker/docker-compose.yml logs -f $(SVC)

# ── infra ──────────────────────────────────────────────────────────────────────
# Infra only: the services themselves run on the host via `make dev-services`,
# so starting their containers here would fight over ports 3000-3007.
infra-up:
	docker compose -f infra/docker/docker-compose.yml up -d postgres redis redpanda
	@echo "Waiting for Postgres to be ready..."
	@until docker compose -f infra/docker/docker-compose.yml exec -T postgres pg_isready -U ride -d ride_app >/dev/null 2>&1; do sleep 1; done
	@echo "$(GREEN)✔  Postgres ready$(RESET)"

# Fully containerized stack (prod-like images, Kong in front). Don't run alongside dev-services.
stack-up:
	@[ -f .env ] || cp .env.example .env
	docker compose -f infra/docker/docker-compose.yml up -d --build

infra-down:
	docker compose -f infra/docker/docker-compose.yml down

infra-reset:
	docker compose -f infra/docker/docker-compose.yml down -v
	@$(MAKE) --no-print-directory infra-up
	@$(MAKE) --no-print-directory db-migrate
	@$(MAKE) --no-print-directory db-seed

# ── database ───────────────────────────────────────────────────────────────────
db-migrate:
	@# Only services with a Prisma schema (payment will join once it has one).
	@# `migrate deploy` creates a missing database and applies the committed migrations without
	@# prompting. `migrate dev` would diff the schema too, and trip-service's generated PostGIS
	@# columns always look like drift to it. To write a new migration, run
	@# `pnpm exec prisma migrate dev --create-only` in that service.
	@for svc in $(PRISMA_SERVICES); do \
	  echo "  migrating $$svc..."; \
	  pnpm --filter @ride-app/$$svc exec prisma migrate deploy || exit 1; \
	done

db-seed:
	pnpm tsx scripts/seed-db.ts

# ── clean ──────────────────────────────────────────────────────────────────────
clean:
	find . -name "node_modules" -type d -prune -exec rm -rf {} + 2>/dev/null; \
	find . -name "dist" -type d -prune -exec rm -rf {} + 2>/dev/null; \
	find . -name ".turbo" -type d -prune -exec rm -rf {} + 2>/dev/null
	@echo "$(GREEN)✔  Clean$(RESET)"
