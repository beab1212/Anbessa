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
        test lint typecheck clean

SHELL := /bin/bash
SERVICES := auth-service trip-service location-service pricing-service \
            payment-service notification-service mapping-service realtime-gateway

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
	@echo "  make setup-mobile     Install Flutter deps for rider + driver apps"
	@echo "  make setup-services   Install Node deps + spin up infra containers"
	@echo "  make setup-admin      Install Node deps for the admin dashboard"
	@echo "  make setup-infra      Bootstrap Terraform + Kubernetes tooling"
	@echo "  make setup            Everything above in one shot"
	@echo ""
	@echo "$(CYAN)Day-to-day dev:$(RESET)"
	@echo "  make dev-services     Start all services in watch mode (hot reload)"
	@echo "  make dev-mobile       Flutter run (prompts which app + device)"
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
	@echo "  make infra-up         Bring up local docker-compose stack"
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
	@command -v melos  >/dev/null || dart pub global activate melos
	melos bootstrap
	@echo "$(GREEN)✔  Mobile ready. Run: make dev-mobile$(RESET)"

setup-services:
	@echo "$(BOLD)→ Services setup$(RESET)"
	@command -v node >/dev/null || (echo "Node ≥20 required. Install via nvm: nvm install" && exit 1)
	@command -v pnpm >/dev/null || npm install -g pnpm@11
	pnpm install
	@$(MAKE) --no-print-directory _copy-env-examples
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
	@for svc in $(SERVICES); do \
	  if [ ! -f services/$$svc/.env ]; then \
	    cp services/$$svc/.env.example services/$$svc/.env 2>/dev/null && echo "  created services/$$svc/.env" || true; \
	  fi; \
	done

# ── dev ────────────────────────────────────────────────────────────────────────
dev-services:
	pnpm turbo run dev --parallel

dev-svc:
	@[ -n "$(SVC)" ] || (echo "Usage: make dev-svc SVC=auth-service" && exit 1)
	pnpm --filter @ride-app/$(SVC) dev

dev-mobile:
	@echo "Which app? (1) rider-app  (2) driver-app"; read n; \
	APP=$$([ "$$n" = "2" ] && echo driver-app || echo rider-app); \
	cd apps/$$APP && flutter run

dev-admin:
	cd apps/admin-dashboard && pnpm dev

dev-infra:
	docker compose -f infra/mapping-stack/docker-compose.mapping.yml up

# ── test ───────────────────────────────────────────────────────────────────────
test:
	pnpm turbo run test
	cd apps/rider-app  && flutter test
	cd apps/driver-app && flutter test

test-svc:
	@[ -n "$(SVC)" ] || (echo "Usage: make test-svc SVC=auth-service" && exit 1)
	pnpm --filter @ride-app/$(SVC) test

# ── lint / types ───────────────────────────────────────────────────────────────
lint:
	pnpm turbo run lint
	cd apps/rider-app  && flutter analyze
	cd apps/driver-app && flutter analyze

typecheck:
	pnpm turbo run typecheck

# ── logs ───────────────────────────────────────────────────────────────────────
logs-svc:
	@[ -n "$(SVC)" ] || (echo "Usage: make logs-svc SVC=auth-service" && exit 1)
	docker compose -f infra/docker/docker-compose.yml logs -f $(SVC)

# ── infra ──────────────────────────────────────────────────────────────────────
infra-up:
	docker compose -f infra/docker/docker-compose.yml up -d
	@echo "Waiting for Postgres to be ready..."
	@until docker compose -f infra/docker/docker-compose.yml exec -T postgres pg_isready -U ride -d ride_app >/dev/null 2>&1; do sleep 1; done
	@echo "$(GREEN)✔  Postgres ready$(RESET)"

infra-down:
	docker compose -f infra/docker/docker-compose.yml down

infra-reset:
	docker compose -f infra/docker/docker-compose.yml down -v
	@$(MAKE) --no-print-directory infra-up
	@$(MAKE) --no-print-directory db-migrate
	@$(MAKE) --no-print-directory db-seed

# ── database ───────────────────────────────────────────────────────────────────
db-migrate:
	@for svc in auth-service trip-service payment-service; do \
	  echo "  migrating $$svc..."; \
	  pnpm --filter @ride-app/$$svc prisma migrate dev --name init 2>/dev/null || \
	  pnpm --filter @ride-app/$$svc prisma migrate deploy; \
	done

db-seed:
	pnpm tsx scripts/seed-db.ts

# ── clean ──────────────────────────────────────────────────────────────────────
clean:
	find . -name "node_modules" -type d -prune -exec rm -rf {} + 2>/dev/null; \
	find . -name "dist" -type d -prune -exec rm -rf {} + 2>/dev/null; \
	find . -name ".turbo" -type d -prune -exec rm -rf {} + 2>/dev/null
	@echo "$(GREEN)✔  Clean$(RESET)"
