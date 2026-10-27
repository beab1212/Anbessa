# Anbessa documentation

Where to find what. Two kinds of docs live in this repo:

- **System-wide docs** in this folder: the architecture, the design decisions behind it, and how to develop, test and ship.
- **Reference docs next to the code**: every service, app, library and the infrastructure has its own `docs/` folder, written from the code. Each describes its routes, events, data, configuration, how it talks to the rest of the system, and how to run it.

When a design doc and a reference doc disagree, the reference doc describes what the code does today; the design doc describes the intent.

## System-wide

| Doc | What it covers |
|---|---|
| [Architecture overview](architecture/overview.md) | Diagrams, services, flows, data, events, security, deployment, known gaps |
| [Design docs](design/README.md) | Auth, roles and permissions, database, payments, and the 16 workflows |
| [API conventions](api/README.md) | Shared conventions for the HTTP APIs |
| [Development](development/README.md) | Setup, ports, the daily loop, troubleshooting |
| [Testing](testing/README.md) | CI gates, unit / widget / integration tests |
| [Production](production/README.md) | Images, Terraform, Kubernetes, config, migrations, releases |

## Cross-cutting references

| Reference | What it covers |
|---|---|
| [Kafka event catalog](../libs/shared-types/docs/event-catalog.md) | Every topic: key, producer, payload, consumers |
| [Roles and permissions](../libs/shared-authz/docs/roles-and-permissions.md) | Every role and permission, with scopes |
| [Tokens](../libs/shared-authz/docs/tokens.md) | How every service verifies access tokens |
| [Live settings catalog](../libs/shared-settings/docs/settings-catalog.md) | Every admin-editable setting, where it is read, defaults |
| [Driver location model](../libs/shared-location/docs/reference.md) | Redis keys, driver states, ping validation, nearby search |

## Services

Each folder has `README.md` (start here), `architecture.md`, `api.md`, `events.md`, `data-model.md`, `integrations.md`, `configuration.md` and `operations.md` (a service without Kafka or a database says so instead of having an empty file).

| Service | Port | Owns | Docs |
|---|---|---|---|
| realtime-gateway | 3000 | Socket.io connections, trip rooms, driver pings in | [docs](../services/realtime-gateway/docs/README.md) |
| auth-service | 3001 | Users, OTP and staff sign-in, sessions, tokens, organisations, roles, approvals | [docs](../services/auth-service/docs/README.md) |
| trip-service | 3002 | Trips and their state machine, matching, offers, cancellations, ratings, saved places, share links | [docs](../services/trip-service/docs/README.md) |
| location-service | 3003 | Live driver positions and states (Redis), nearby search, ETA to pickup | [docs](../services/location-service/docs/README.md) |
| pricing-service | 3004 | Fares, quotes, estimates with route and ETA | [docs](../services/pricing-service/docs/README.md) |
| payment-service | 3005 | Ledger, balances, settlement, charges, top-ups, payouts, refunds, earnings | [docs](../services/payment-service/docs/README.md) |
| notification-service | 3006 | OTP delivery, push, notification history | [docs](../services/notification-service/docs/README.md) |
| mapping-service | 3007 | Routing (OSRM), distance tables, search | [docs](../services/mapping-service/docs/README.md) |
| fleet-service | 3008 | Drivers, vehicles, documents, review, driving sessions | [docs](../services/fleet-service/docs/README.md) |
| audit-service | 3010 | The append-only audit log | [docs](../services/audit-service/docs/README.md) |
| platform-service | 3011 | Live settings, cities, vehicle types, client config, announcements | [docs](../services/platform-service/docs/README.md) |

## Apps

| App | Docs |
|---|---|
| Phone app (Flutter, rider + driver) | [docs](../apps/phone-app/docs/README.md) |
| Shared Dart package `ride_app_core` (models, API client, design system) | [docs](../packages/core/docs/README.md) |
| Web app (staff console, partner portal, shared-trip page) | [docs](../apps/web/docs/README.md) |

## Libraries

| Library | Docs |
|---|---|
| `@ride-app/shared-authz`: roles, permissions, token verification | [docs](../libs/shared-authz/docs/README.md) |
| `@ride-app/shared-types`: event payloads and DTOs | [docs](../libs/shared-types/docs/README.md) |
| `@ride-app/shared-location`: driver state in Redis, cities | [docs](../libs/shared-location/docs/README.md) |
| `@ride-app/shared-settings`: the live settings registry and client | [docs](../libs/shared-settings/docs/README.md) |
| `@ride-app/shared-utils`: logger, errors | [docs](../libs/shared-utils/docs/README.md) |
| `@ride-app/shared-config`: env helpers | [docs](../libs/shared-config/docs/README.md) |

## Infrastructure

[infra/docs](../infra/docs/README.md): local development (compose, Makefile, scripts), Kong, Kubernetes, Terraform, the mapping stack, CI/CD, data stores, and the production checklist.
