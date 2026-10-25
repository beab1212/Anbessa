# ==============================================================================
# ride-app — Makefile
#
# Run `make help` to see everything available.
# The four team entry points are:
#   make setup-mobile     → Flutter team
#   make setup-services   → Backend team
#   make setup-infra      → DevOps/infra team
#   make setup-admin      → Admin dashboard team
# ==============================================================================

.DEFAULT_GOAL := help
.PHONY: help setup setup-mobile setup-services setup-admin setup-infra \
        dev-services dev-mobile dev-admin dev-infra \
        stack-up secrets test lint typecheck clean

SHELL := /bin/bash
SERVICES := auth-service trip-service location-service pricing-service \
            payment-service notification-service mapping-service realtime-gateway
PRISMA_SERVICES := auth-service

# Local-dev JWT key pair. Paths match JWT_*_KEY_PATH in services/*/.env.example.
# Production keys never come from here — see docs/production/README.md.
SECRETS_DIR := secrets
JWT_PRIVATE := $(SECRETS_DIR)/jwt-private.pem
JWT_PUBLIC  := $(SECRETS_DIR)/jwt-public.pem

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
	@echo "  make setup-admin      Install Node deps for the admin dashboard"
	@echo "  make setup-infra      Bootstrap Terraform + Kubernetes tooling"
	@echo "  make setup            Everything above in one shot"
	@echo "  make secrets          Create the local dev JWT key pair (never overwrites)"
	@echo ""
	@echo "$(CYAN)Day-to-day dev:$(RESET)"
	@echo "  make dev-services     Start all services in watch mode (hot reload)"
	@echo "  make dev-mobile       Flutter run the phone app (rider + driver modes)"
	@echo "  make dev-admin        Start the admin dashboard dev server"
	@echo "  make dev-infra        Start the local mapping stack"
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
setup: setup-services setup-mobile setup-admin
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

setup-admin:
	@echo "$(BOLD)→ Admin dashboard setup$(RESET)"
	cd apps/admin-dashboard && pnpm install
	@cp -n apps/admin-dashboard/.env.example apps/admin-dashboard/.env 2>/dev/null || true
	@echo "$(GREEN)✔  Admin ready. Run: make dev-admin$(RESET)"

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
	@command -v openssl >/dev/null || (echo "openssl is required to create dev JWT keys" && exit 1)
	@git check-ignore -q $(JWT_PRIVATE) || (echo "Refusing: $(JWT_PRIVATE) is not gitignored" && exit 1)
	@umask 077; mkdir -p $(SECRETS_DIR); chmod 700 $(SECRETS_DIR); \
	if [ ! -f $(JWT_PRIVATE) ]; then \
	  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out $(JWT_PRIVATE) 2>/dev/null || exit 1; \
	  rm -f $(JWT_PUBLIC); \
	  echo "  created $(JWT_PRIVATE) (local dev only)"; \
	fi; \
	if [ ! -f $(JWT_PUBLIC) ]; then \
	  openssl pkey -in $(JWT_PRIVATE) -pubout -out $(JWT_PUBLIC) || exit 1; \
	  echo "  created $(JWT_PUBLIC)"; \
	fi; \
	chmod 600 $(JWT_PRIVATE); chmod 644 $(JWT_PUBLIC); \
	if [ "$$(stat -c %a $(JWT_PRIVATE))" != "600" ]; then \
	  echo "  ⚠  this filesystem ignores Unix permissions: $(JWT_PRIVATE) is readable by other local users."; \
	  echo "     Fine for throwaway dev keys; never put real keys on this disk."; \
	fi

# ── dev ────────────────────────────────────────────────────────────────────────
dev-services: secrets
	pnpm turbo run dev --parallel

dev-svc: secrets
	@[ -n "$(SVC)" ] || (echo "Usage: make dev-svc SVC=auth-service" && exit 1)
	pnpm --filter @ride-app/$(SVC) dev

dev-mobile:
	cd apps/rider-app && flutter run

dev-admin:
	cd apps/admin-dashboard && pnpm dev

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
	@# Only services with a Prisma schema (trip/payment will join once they have one).
	@for svc in $(PRISMA_SERVICES); do \
	  echo "  migrating $$svc..."; \
	  pnpm --filter @ride-app/$$svc exec prisma migrate dev || exit 1; \
	done

db-seed:
	pnpm tsx scripts/seed-db.ts

# ── clean ──────────────────────────────────────────────────────────────────────
clean:
	find . -name "node_modules" -type d -prune -exec rm -rf {} + 2>/dev/null; \
	find . -name "dist" -type d -prune -exec rm -rf {} + 2>/dev/null; \
	find . -name ".turbo" -type d -prune -exec rm -rf {} + 2>/dev/null
	@echo "$(GREEN)✔  Clean$(RESET)"
