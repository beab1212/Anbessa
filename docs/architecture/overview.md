# Architecture overview

Anbessa is a ride-hailing platform. It's built as **independently deployable microservices** in one monorepo, with one phone app (rider + driver modes) and one web app (staff dashboard, fleet portal and corporate portal).

This document describes the target architecture **and** where the code is today, so you know what you can rely on. Each section marks its status:

| Marker | Meaning |
|---|---|
| ✅ | Implemented and runnable |
| 🟡 | Partly implemented, or implemented with known defects |
| 📐 | Designed and scaffolded, not implemented yet |

Related docs: [design docs](../design/README.md) · [roles & permissions design](../design/Role.md) · [development](../development/README.md) · [testing](../testing/README.md) · [production](../production/README.md) · [API conventions](../api/README.md)

---

## Contents

1. [System context](#1-system-context)
2. [Containers](#2-containers)
3. [Services and ownership](#3-services-and-ownership)
4. [Communication](#4-communication)
5. [Key flows](#5-key-flows)
6. [Trip lifecycle](#6-trip-lifecycle)
7. [Data architecture](#7-data-architecture)
8. [Event catalog](#8-event-catalog)
9. [Security](#9-security)
10. [Mapping stack](#10-mapping-stack)
11. [Deployment topology](#11-deployment-topology)
12. [Scalability and resilience](#12-scalability-and-resilience)
13. [Observability](#13-observability)
14. [Repository map](#14-repository-map)
15. [Key decisions](#15-key-decisions)
16. [Known gaps](#16-known-gaps)

---

## 1. System context

Who uses the system and which external systems it depends on.

```mermaid
flowchart TB
  Rider([Rider<br/>phone app, rider mode])
  Driver([Driver<br/>phone app, driver mode])
  Ops([Staff, fleet owners, corporate admins<br/>web app])

  subgraph Anbessa["Anbessa platform"]
    Core[Ride-hailing backend]
  end

  Stripe[(Stripe Connect<br/>charges + payouts)]
  FCM[(Firebase Cloud Messaging<br/>push)]
  Twilio[(Twilio<br/>SMS fallback)]
  TG[(Telegram Gateway API<br/>login codes)]
  OSM[(OpenStreetMap data<br/>Geofabrik extracts)]

  Rider -->|book, track, pay| Core
  Driver -->|go online, accept, stream GPS| Core
  Ops -->|monitor trips, drivers, payouts| Core
  Core -->|charge riders, pay drivers| Stripe
  Core -->|push notifications| FCM
  Core -->|SMS| Twilio
  Core -->|verification codes| TG
  OSM -->|imported into self-hosted mapping| Core
```

**Design goals**

- **No per-request map fees.** Routing, geocoding and tiles are self-hosted on OpenStreetMap data.
- **Real-time first.** Live driver positions reach riders within about a second.
- **Independent teams.** Mobile, backend, admin and infra each have their own entry point (`make setup-*`) and workspace.
- **Independent scaling.** The high-frequency location path scales separately from low-traffic services such as pricing.

---

## 2. Containers

The deployable pieces and how they connect.

```mermaid
flowchart LR
  subgraph Clients
    App["Phone app<br/>apps/phone-app<br/>Flutter (rider + driver)"]
    Admin["Web app<br/>apps/web<br/>React + Vite<br/>staff · fleet · corporate"]
  end

  subgraph Edge
    Kong["Kong API gateway :8000<br/>routing · rate limits"]
    RT["realtime-gateway :3000<br/>Socket.io over WebSocket"]
  end

  subgraph Services["Node.js microservices (services/*)"]
    Auth["auth-service :3001"]
    Trip["trip-service :3002"]
    Loc["location-service :3003"]
    Pricing["pricing-service :3004"]
    Pay["payment-service :3005"]
    Notif["notification-service :3006"]
    Map["mapping-service :3007"]
  end

  subgraph Data["Data & messaging"]
    PG[("PostgreSQL 18 + PostGIS<br/>one DB per service")]
    Redis[("Redis 8<br/>geo index · socket backplane · cache")]
    Kafka[("Kafka<br/>Redpanda locally · MSK in prod")]
  end

  subgraph Mapping["Self-hosted mapping (infra/mapping-stack)"]
    OSRM["OSRM :5000<br/>routes · ETA · matrices"]
    Nom["Nominatim :8080<br/>geocoding"]
    Tiles["TileServer GL :8081<br/>map tiles"]
  end

  App -->|HTTPS /api/*| Kong
  Admin -->|HTTPS /api/*| Kong
  App <-->|WSS| RT
  App -->|tiles| Tiles

  Kong --> Auth & Trip & Pricing & Pay

  Trip --> Loc
  Trip --> Map
  Pricing --> Map
  Loc --> Map
  Map --> OSRM & Nom

  Auth --> PG
  Trip --> PG
  Pay --> PG
  Loc --> Redis
  RT --> Redis

  Auth -.->|user.created| Kafka
  RT -.->|driver.location| Kafka
  Trip -.->|"trip.*"| Kafka
  Pay -.->|"payment.*"| Kafka
  Kafka -.-> Notif & Trip & Pay & Loc
```

Solid arrows are synchronous calls (HTTP, WebSocket, DB). Dashed arrows are asynchronous events.

---

## 3. Services and ownership

Each service owns one business capability **and its data**. No service reads another service's database.

| Service | Port | Responsibility | Owns | Status |
|---|---|---|---|---|
| **auth-service** | 3001 | Identity on **Better Auth** ([Auth.md](../design/Auth.md)): phone OTP and staff password + TOTP, sessions, organisations, ES256 JWTs + JWKS, `/api/identity` (guests, maker–checker staff roles, suspension) | `auth_service` DB: users, sessions, organisations, members, signing keys, approvals, outbox | ✅ implemented, unit + integration tests |
| **trip-service** | 3002 | Trip lifecycle state machine, driver–rider matching | `trip_service` DB: trips | 📐 `/health` only |
| **location-service** | 3003 | Nearby-driver queries, ETA lookups | Redis geo index (read side) | 📐 `/health` only |
| **pricing-service** | 3004 | Fare estimates, surge multipliers | Pricing rules (stateless today) | 📐 `/health` only |
| **payment-service** | 3005 | Fare capture and driver payouts (Stripe Connect), idempotent charges | `payment_service` DB: charges, payouts | 📐 `/health` only |
| **notification-service** | 3006 | Push (FCM) and SMS from events. **Login codes via the Telegram Gateway API, SMS fallback** (internal API from auth-service, never Kafka: [Auth.md §9.7](../design/Auth.md#97-otp-delivery-telegram-gateway-first-sms-fallback)) | `notification_service` DB: `otp_delivery`, `notification` (dedupe log), `device_token` | ✅ OTP delivery (Telegram + SMS fallback), invite SMS and driver-activated push from Kafka, device tokens. Trip/payment notifications wait for those events |
| **mapping-service** | 3007 | The only gateway to OSRM / Nominatim / tiles | Route cache | 📐 `/health` only |
| **realtime-gateway** | 3000 | WebSocket connections, live location fan-out | Socket rooms (in Redis) | 🟡 auth + location relay work; crashes on Kafka publish |

### Internal structure (auth-service is the reference template)

```mermaid
flowchart LR
  R["routes/"] --> C["controllers/<br/>parse request, shape response"]
  C --> S["services/<br/>business logic"]
  S --> Repo["repositories/<br/>only layer touching Prisma/Redis"]
  S --> E["events/producers/<br/>Kafka publish"]
  Repo --> DB[(own database)]
  Cfg["config/<br/>Zod-validated env"] -.-> S & Repo & E
  App["app.ts<br/>builds Fastify, no listen"] --> R
  Srv["server.ts<br/>listen + graceful shutdown"] --> App
```

- `app.ts` builds the Fastify instance without calling `listen()`, so tests can drive it with `app.inject()`.
- `server.ts` handles `SIGTERM`/`SIGINT`, closing the server so in-flight requests finish.
- `config/` parses `process.env` with Zod at boot and fails fast. Key files are checked with `existingFile()` from `@ride-app/shared-config`.

### Shared libraries (`libs/*`)

| Library | Contents | Rule |
|---|---|---|
| `@ride-app/shared-types` | Domain types (`Trip`, `TripStatus`, `PublicUser`), **Kafka event contracts** | The contract boundary between services |
| `@ride-app/shared-utils` | `createLogger` (pino), `AppError`, `NotFoundError` | Generic utilities only |
| `@ride-app/shared-config` | `loadEnv`, `existingFile` | Env validation helpers |

> Libraries hold **contracts and generic utilities**, never business logic or database access. Sharing logic would couple service releases.

The Dart side mirrors the contracts in `packages/core` (e.g. `TripStatus`), synchronised by hand for now.

---

## 4. Communication

| Style | Technology | Used for | Examples |
|---|---|---|---|
| Synchronous request/response | HTTP/JSON through Kong | Client actions that need an immediate answer | login, fare estimate, request trip |
| Synchronous internal | HTTP between services | Queries across service boundaries | trip → location ("nearby drivers"), pricing → mapping |
| Real-time push | WebSocket (Socket.io) | Live updates both ways | driver GPS → rider map |
| Asynchronous events | Kafka topics | Side effects, replication, analytics | `user.created`, `driver.location`, `trip.completed` |
| Fan-out between gateway pods | Redis pub/sub (Socket.io adapter) | Delivering a room message to a socket on another pod | `trip:<id>` room broadcasts |

### When to use which

```mermaid
flowchart TD
  Q{Does the caller need<br/>the result now?}
  Q -->|yes| H[HTTP request<br/>with timeout + retry]
  Q -->|no| E{Must it survive<br/>crashes and be replayable?}
  E -->|yes| K[Kafka event]
  E -->|no, real-time only| P[WebSocket / Redis pub/sub]
```

### Gateway routes (`infra/kong/kong.yml`)

| Path | Upstream | Plugins |
|---|---|---|
| `/api/auth` | auth-service:3001 | rate-limiting 30/min |
| `/api/trips` | trip-service:3002 | jwt, rate-limiting 60/min |
| `/api/pricing` | pricing-service:3004 | jwt |
| `/api/payments` | payment-service:3005 | jwt, rate-limiting 20/min |

The realtime gateway is reached directly (through the load balancer), not through Kong.

---

## 5. Key flows

The flows below are summaries. Each business process is designed end to end, with steps, timeouts, failures and events, in **[docs/design/workflows](../design/workflows/README.md)**.

### 5.1 Login and session (target design: Better Auth)

```mermaid
sequenceDiagram
  autonumber
  participant App as Phone app
  participant Kong
  participant BA as auth-service (Better Auth)
  participant N as notification-service
  participant S as Any service

  App->>Kong: POST /api/auth/phone-number/send-otp {+2519…}
  Kong->>BA: (rate limited at edge and in Better Auth)
  BA-->>N: deliver the code (internal mTLS): Telegram first, SMS fallback
  App->>BA: POST /api/auth/phone-number/verify {phone, code}
  BA->>BA: first time → create user (role rider)
  BA-->>App: session token (bearer, 30 days)
  App->>BA: GET /api/auth/token (Bearer session)
  BA-->>App: JWT (ES256, 15 min) {sub, roles, pv}
  App->>App: roles contain DRIVER → driver home, else rider home
  App->>S: request with Bearer JWT
  S->>S: verify signature with cached JWKS, check iss/aud/pv, then permission + scope
```

- Services verify JWTs **locally** against Better Auth's JWKS (`/api/auth/jwks`, keys rotated every 90 days). There's no call back to auth-service per request.
- Staff use the admin surface (`/api/admin-auth`, password + TOTP, `aud = ride-admin`). See [Auth.md §8–9](../design/Auth.md#8-sessions-and-tokens).
- **Today** the code still has hand-written email/password `register`/`login` that signs RS256 tokens with key files (and both endpoints currently fail, [§16](#16-known-gaps)).

### 5.2 Request a trip (target design)

```mermaid
sequenceDiagram
  autonumber
  participant R as Rider app
  participant Kong
  participant P as pricing-service
  participant M as mapping-service
  participant O as OSRM
  participant T as trip-service
  participant L as location-service
  participant K as Kafka
  participant N as notification-service
  participant D as Driver app

  R->>Kong: POST /api/pricing/estimate {pickup, dropoff}
  Kong->>P: forward (P verifies the JWT)
  P->>M: GET /route?from&to
  M->>O: GET /route/v1/driving (pickup → dropoff)
  O-->>M: distance, duration
  M-->>P: distance, duration
  P-->>R: fare estimate (+ surge)

  R->>Kong: POST /api/trips {pickup, dropoff, estimateId}
  Kong->>T: forward (T verifies the JWT)
  T->>T: create Trip{status: requested} in own DB
  T->>K: trip.requested
  T->>L: nearby drivers (pickup, radius)
  L-->>T: candidates (Redis GEOSEARCH)
  T->>M: duration matrix candidates → pickup
  M-->>T: ETAs (OSRM /table)
  T->>T: pick best driver → status matched
  T->>K: trip.matched
  K->>N: trip.matched
  N->>D: push "new trip"
  T-->>R: trip {id, status: matched, driver, eta}
```

### 5.3 Live location tracking

```mermaid
sequenceDiagram
  autonumber
  participant D as Driver app
  participant GA as realtime-gateway pod A
  participant Redis
  participant GB as realtime-gateway pod B
  participant R as Rider app
  participant K as Kafka

  R->>GB: connect (auth.token) → verified once at handshake
  R->>GB: trip:subscribe "trip-42" → joins room trip:trip-42
  D->>GA: connect (auth.token)
  loop every ~4 s
    D->>GA: location:update {tripId, lat, lng, heading}
    GA->>Redis: GEOADD drivers:geo lng lat driverId
    GA->>Redis: publish room trip:trip-42 (Socket.io adapter)
    Redis-->>GB: room message
    GB-->>R: driver:location {driverId, lat, lng}
    GA->>K: driver.location (key = driverId)
  end
```

- `driverId` comes from the verified token's `sub`, never from the message body.
- Redis gives sub-millisecond nearby search. Kafka gives a durable stream for ETA recalculation, audit and analytics.

### 5.4 Trip completion and payment (target design)

```mermaid
sequenceDiagram
  autonumber
  participant D as Driver app
  participant T as trip-service
  participant K as Kafka
  participant Pay as payment-service
  participant S as Stripe
  participant N as notification-service

  D->>T: complete trip
  T->>T: status in_progress → completed (+ outbox row, same transaction)
  T->>K: trip.completed {eventId, tripId, fareCents}
  K->>Pay: trip.completed
  Pay->>Pay: dedupe by eventId
  Pay->>S: charge rider (idempotency key = tripId)
  S-->>Pay: succeeded
  Pay->>K: payment.captured
  K->>N: payment.captured
  N->>N: push receipt to rider, earnings update to driver
  Note over Pay,S: on failure → payment.failed → trip marked unpaid (saga compensation)
```

---

## 6. Trip lifecycle

The state machine owned by trip-service. The states come from `libs/shared-types/src/trip.ts` and are mirrored in `packages/core/lib/models/trip.dart`.

```mermaid
stateDiagram-v2
  [*] --> requested: rider requests
  requested --> matched: driver assigned
  requested --> cancelled: rider cancels / no driver found
  matched --> en_route: driver heading to pickup
  matched --> cancelled: rider or driver cancels
  en_route --> in_progress: rider picked up
  en_route --> cancelled: cancel before pickup (fee may apply)
  in_progress --> completed: dropped off
  completed --> [*]
  cancelled --> [*]
```

| Transition | Event published | Typical consumers |
|---|---|---|
| → requested | `trip.requested` | analytics |
| → matched | `trip.matched` | notification (driver push), realtime |
| → en_route | `trip.driver_en_route` | notification (rider) |
| → in_progress | `trip.started` | analytics |
| → completed | `trip.completed` | payment, notification |
| → cancelled | `trip.cancelled` | payment (cancellation fee), notification |

Rules: only trip-service changes a trip's status. Each transition is a single DB transaction that also writes an outbox row (see [§8](#8-event-catalog)). Illegal transitions (e.g. `completed → en_route`) are rejected.

---

## 7. Data architecture

### Ownership

```mermaid
flowchart LR
  subgraph PG["PostgreSQL instance (one per environment)"]
    A[(auth_service)]
    T[(trip_service)]
    P[(payment_service)]
  end
  Auth[auth-service] --> A
  Trip[trip-service] --> T
  Pay[payment-service] --> P
  RT[realtime-gateway] --> R[(Redis)]
  Loc[location-service] --> R
  Trip -.->|"❌ no cross-service SELECTs"| A
```

| Store | Data | Durability | Production |
|---|---|---|---|
| PostgreSQL 18 + PostGIS | Users, trips, payments; zones and pickups (geography) | Durable, the system of record | Amazon RDS |
| Redis 8 | Live driver positions (`drivers:geo`), Socket.io room fan-out, caches | **Rebuildable**: lost data regenerates within seconds | Amazon ElastiCache |
| Kafka | Domain event streams | Durable, retained, replayable | Amazon MSK |

### Current schema (auth-service)

```mermaid
erDiagram
  User {
    string id PK "uuid"
    string email UK
    string phone UK
    string passwordHash "argon2id"
    Role role "RIDER | DRIVER | ADMIN"
    datetime createdAt
    datetime updatedAt
  }
```

- Managed by Prisma 7 (`services/auth-service/prisma/schema.prisma`, `prisma.config.ts`, `@prisma/adapter-pg`).
- Migrations are committed under `prisma/migrations/` and applied with `prisma migrate deploy` in production.

### Rules

- **Database per service.** Separate databases and, in production, separate DB users.
- **Need another service's data?** Call its API, or keep a local read model updated from its events.
- **Hot vs durable geo data.** Live positions go in Redis GEO. Zones, pickups and history go in PostGIS.
- **Schema changes** follow expand → migrate → contract, so old and new pods can run during a rollout.

---

## 8. Event catalog

Contracts live in `libs/shared-types/src/events.ts`. Producer and consumer import the same type.

| Topic | Key | Producer | Payload | Consumers | Status |
|---|---|---|---|---|---|
| `user.created` | `userId` | auth-service | `{ userId, guest }` | trip (rider cache) | 🟡 produced; no consumers yet |
| `org.member_invited` | `orgId` | auth-service | `{ invitationId, orgId, orgName, role, phoneNumber? }` | notification (invite SMS) | ✅ |
| `role.granted` / `role.revoked` | `userId` | auth-service | `{ userId, role, orgId?, cityId?, byUserId }` | notification (driver activated push), audit | ✅ produced, notification consumes `DRIVER` grants |
| `driver.location` | `driverId` | realtime-gateway | `{ driverId, tripId, lat, lng, heading?, at }` | ETA, trip audit, analytics | 🟡 publish crashes (producer not connected) |
| `trip.requested` / `matched` / `driver_en_route` / `started` / `completed` / `cancelled` | `tripId` | trip-service | trip snapshot + transition | payment, notification, analytics | 📐 |
| `payment.captured` / `payment.failed` | `tripId` | payment-service | `{ tripId, amountCents, … }` | trip, notification | 📐 |

### Event conventions

```mermaid
flowchart LR
  subgraph Producer["Producer service (one DB transaction)"]
    W[write state change] --> O[insert outbox row]
  end
  O --> Relay[outbox relay] -->|publish, then mark sent| Topic[(Kafka topic)]
  Topic --> C1[consumer group A]
  Topic --> C2[consumer group B]
  C1 --> Dedupe{eventId<br/>already processed?}
  Dedupe -->|no| Handle[handle + record eventId]
  Dedupe -->|yes| Skip[skip]
  Handle -->|fails N times| DLQ[(topic.dlq)]
```

- **Names** are past-tense facts: `trip.completed`, not `completeTrip`.
- **Keys** are the entity whose ordering matters (Kafka orders within a partition).
- **Payloads** carry `eventId` (dedupe), `at` (event time) and a `version`.
- **Delivery** is at-least-once, so consumers must be idempotent.
- **Evolution:** add optional fields only. Breaking changes go in a new version or topic.
- **Outbox (target):** today auth-service publishes *after* committing, so an event can be lost if Kafka is down.

---

## 9. Security

### Authentication and trust boundaries

```mermaid
flowchart LR
  subgraph Public["Public internet"]
    C[Clients]
  end
  subgraph EdgeZ["Edge (TLS terminated)"]
    LB[Load balancer]
    Kong["Kong: routing + rate limits"]
    RT["realtime-gateway: verifies JWT at handshake"]
  end
  subgraph Private["Private network: no public IPs"]
    S["Services: verify JWT (JWKS) + authorize per resource"]
    D[(Databases, Redis, Kafka)]
  end
  C -->|HTTPS / WSS| LB --> Kong & RT
  Kong --> S
  RT --> D
  S --> D
```

| Concern | Approach |
|---|---|
| Passwords | argon2id hashes. Plaintext is never stored or logged |
| Roles | Scoped roles with one permission matrix (`libs/shared-authz`) and maker–checker staff grants. See [docs/design/Role.md](../design/Role.md) |
| Authentication | Better Auth in auth-service: phone OTP for the app, password + TOTP for staff, organisations, JWT + JWKS (ES256, rotated), verified in each service. See [docs/design/Auth.md](../design/Auth.md) |
| Tokens | Better Auth sessions (app 30 days via bearer, admin 12 h cookie) + short-lived ES256 JWTs (app 15 min, admin 10 min) with `pv` and a Redis denylist for suspensions |
| Signing key | Generated, encrypted (with `BETTER_AUTH_SECRET`) and rotated by Better Auth in the `jwks` table, published at `/api/auth/jwks`. Only auth-service can sign. No key files |
| Edge auth | Kong does routing, rate limits and request-size limits only. realtime-gateway (and every service, as it gets routes) verifies JWTs with the JWKS through `libs/shared-authz` |
| Authorization | In the owning service (e.g. only the trip's rider or driver may read it). Never "the gateway checked" |
| Rate limiting | Kong per route (stricter on `/api/auth` and `/api/payments`) |
| Payments | Idempotency keys per trip. Card data never touches our systems (Stripe) |
| Network | Databases, Redis and Kafka in private subnets. TLS to RDS, ElastiCache and MSK in production |

### Secrets

| Environment | Source | Delivery |
|---|---|---|
| Local dev | `make secrets` (creates `.env` files, generates `BETTER_AUTH_SECRET` and `INTERNAL_SERVICE_TOKEN`, `umask 077`, never overwrites, gitignored) | Env vars |
| CI | GitHub environment secrets, OIDC to AWS (no static keys) | Masked env vars |
| Staging / production | AWS Secrets Manager → External Secrets → Kubernetes Secrets | `envFrom` + read-only key-file mounts |

Secrets are never committed (`.gitignore`), never baked into images (`.dockerignore`), and never logged.

---

## 10. Mapping stack

The self-hosted, free replacement for commercial map APIs. Only **mapping-service** talks to it, so the engines can be swapped without touching other services.

```mermaid
flowchart LR
  PBF["Geofabrik extract<br/>ethiopia-latest.osm.pbf"] -->|osrm-extract / partition / customize| OSRM["OSRM :5000<br/>/route · /table · /nearest · /match"]
  PBF -->|import + replication diffs| NOM["Nominatim :8080<br/>/search · /reverse"]
  PBF -->|Planetiler| MB[region.mbtiles] --> TS["TileServer GL :8081<br/>z/x/y tiles"]

  OSRM --> MS["mapping-service :3007<br/>normalise · cache · timeouts"]
  NOM --> MS
  MS --> Pricing[pricing] & Trip[trip] & Loc[location]
  TS -->|via CDN in production| App[phone app map]
```

| Need | Engine | Notes |
|---|---|---|
| Road distance and ETA for fares | OSRM `/route` | Straight-line (PostGIS) distance is only a fallback |
| Rank nearby drivers by real arrival time | OSRM `/table` | After Redis `GEOSEARCH` finds candidates |
| Destination search, pickup labels | Nominatim | Bounded to the service area (`countrycodes`, `viewbox`) |
| Map display | TileServer GL | Raster/vector tiles, OSM attribution required |

---

## 11. Deployment topology

### Local development

```mermaid
flowchart TB
  subgraph Host["Developer machine"]
    Dev["make dev-services<br/>8 services · tsx watch · hot reload<br/>ports 3000–3007"]
    AdminDev["make dev-web :5173"]
    Mobile["make dev-mobile<br/>emulator / device"]
  end
  subgraph Compose["make infra-up (docker compose)"]
    PG[(postgis 18-3.6 :5432)]
    RD[(redis 8 :6379)]
    RP[(redpanda v26 :9092)]
  end
  Dev --> PG & RD & RP
  Mobile -->|10.0.2.2 on the Android emulator| Dev
```

| Mode | Command | Use |
|---|---|---|
| Host dev | `make infra-up` + `make dev-services` | Daily coding, hot reload, libs loaded from source |
| Containerized stack | `make stack-up` | Prod-like images plus Kong on `:8000`. Don't run alongside host dev (ports clash) |
| One service | `services/<svc>/docker-compose.dev.yml` + `pnpm dev` | Isolated work |

### Production (AWS, target)

```mermaid
flowchart TB
  Users((Riders, drivers, ops)) --> CDN[CDN<br/>tiles + admin static]
  Users --> ALB[Application Load Balancer<br/>TLS · WebSocket]
  subgraph VPC["VPC across 3 availability zones"]
    subgraph EKS["Amazon EKS"]
      KongP[Kong pods]
      RTP[realtime-gateway pods]
      SVC[service pods × 7<br/>HPA 2–10 each]
      MapP[OSRM / Nominatim / TileServer]
    end
    RDS[(RDS PostgreSQL + PostGIS<br/>Multi-AZ)]
    EC[(ElastiCache Redis/Valkey<br/>primary + replica)]
    MSK[(MSK Kafka<br/>3 brokers)]
  end
  SM[Secrets Manager] -.->|External Secrets| EKS
  ECR[(Image registry)] -.->|images tagged with git SHA| EKS
  ALB --> KongP & RTP
  CDN --> MapP
  KongP --> SVC
  SVC --> RDS & EC & MSK
  RTP --> EC & MSK
  SVC --> MapP
```

### Delivery pipeline

```mermaid
flowchart LR
  PR[Pull request] --> CI["CI: lint · typecheck · test · build<br/>melos analyze · test"]
  CI --> Main[merge to main]
  Main --> Img["build 8 images<br/>tag = git SHA"]
  Img --> Mig["prisma migrate deploy 📐"]
  Mig --> Stg["deploy staging<br/>kustomize overlay"]
  Stg --> Gate{manual approval}
  Gate --> Prod["deploy production<br/>same image"]
```

The infrastructure is defined in `infra/terraform` (EKS, RDS, ElastiCache, MSK) and `infra/k8s` (Kustomize base + staging/production overlays). See the [production guide](../production/README.md) for the readiness checklist.

---

## 12. Scalability and resilience

| Component | Scales by | Watch out for |
|---|---|---|
| Stateless services | HPA on CPU (2–10 replicas) | DB connections: replicas × pool size must stay under `max_connections` |
| realtime-gateway | More pods, with Redis adapter fan-out | LB idle timeouts, reconnect waves on deploy |
| Kafka consumers | Consumers per group, up to the partition count | Partition count caps parallelism. Plan it per topic |
| Redis | Vertical first, then cluster mode | Multi-key ops need hash tags in cluster mode |
| PostgreSQL | Vertical, read replicas, RDS Proxy | Long transactions, missing indexes |
| Mapping | More OSRM/Nominatim replicas, CDN for tiles | Memory per OSRM instance scales with region size |

### Failure handling

| Failure | Effect (target design) |
|---|---|
| notification-service down | Events wait in Kafka; notifications arrive late, nothing else breaks |
| payment-service down | Trips still complete; charges are processed on recovery (events retained) |
| mapping/OSRM slow or down | Timeouts + cached routes. Fare falls back to a straight-line estimate |
| Redis down | No nearby search or live tracking; positions rebuild within seconds of recovery |
| A pod crashes | Kubernetes restarts it; readiness keeps traffic away until it's healthy |
| Bad deploy | Rolling update keeps old pods serving; `kubectl rollout undo` |

Every synchronous call needs a timeout, retries with backoff for idempotent operations, and a fallback where possible. Liveness probes never depend on databases (that would cause restart storms); readiness probes do.

---

## 13. Observability

| Signal | Today | Target |
|---|---|---|
| Logs | ✅ pino JSON to stdout (pretty in dev, `info` level in production) | Shipped by the cluster log agent; a correlation ID on every request and event |
| Health | ✅ `GET /health` on every service; Docker `HEALTHCHECK`; Kubernetes probes | Split `/health/live` and `/health/ready` (ready checks DB + Kafka) |
| Metrics | 📐 | Request rate, errors, latency per route; Kafka consumer lag; socket count |
| Tracing | 📐 | OpenTelemetry across Kong → services → Kafka |
| Alerts | 📐 | Error-rate SLOs, consumer lag, RDS/ElastiCache/MSK health |

---

## 14. Repository map

```
Anbessa/
├── apps/
│   ├── phone-app/          Flutter phone app, rider AND driver modes (role-based)
│   └── web/                React + Vite web app: staff dashboard, fleet and corporate portals (role-based)
├── packages/core/          Shared Dart models + widgets
├── services/               8 Node.js microservices (one image each)
├── libs/                   shared-types · shared-utils · shared-config
├── infra/
│   ├── docker/             local compose stack
│   ├── kong/               declarative gateway config
│   ├── mapping-stack/      OSRM · Nominatim · TileServer GL
│   ├── k8s/                Kustomize base + overlays
│   └── terraform/          AWS: EKS · RDS · ElastiCache · MSK
├── docs/                   architecture · development · testing · production · api
├── learned/                Obsidian learning notes per technology
└── Makefile                team entry points (`make help`)
```

| Concern | Tooling |
|---|---|
| Node monorepo | pnpm 11 workspaces + Turborepo |
| Dart monorepo | Dart pub workspace + Melos 8 |
| Runtimes | Node 24 LTS, Flutter 3.44 / Dart 3.12, TypeScript 7 |

---

## 15. Key decisions

| # | Decision | Why | Trade-off |
|---|---|---|---|
| 1 | Microservices in a **monorepo** | Atomic changes to shared contracts; one toolchain | Needs task caching and affected-only CI to stay fast |
| 2 | **One phone app** with rider and driver modes | One codebase, release and set of shared widgets | The app bundle contains both experiences |
| 3 | **Kafka** for inter-service events, **Redis pub/sub** only for socket fan-out | Durable, replayable and ordered vs instant and ephemeral | Two messaging systems to operate |
| 4 | **Asymmetric JWTs verified by each service** (ES256 via Better Auth's JWKS, with rotation) | Stateless verification; only auth-service can sign; keys rotate without redeploys | Revocation needs short TTLs plus the suspension denylist |
| 5 | **Self-hosted OSM** mapping behind mapping-service | No per-request fees; engines are swappable | You operate OSRM, Nominatim and tile servers |
| 6 | **Database per service** on shared Postgres instances | Isolation without one server per service | No cross-service joins; eventual consistency |
| 7 | **Redis GEO** for live positions, **PostGIS** for durable geo | Write-heavy hot path vs queryable history | Two geo stores to keep consistent |
| 8 | **Managed** data services in production (RDS, ElastiCache, MSK) | Backups, failover and patching handled by AWS | Cost; some vendor coupling |
| 9 | **Kong DB-less** declarative config | Gateway config reviewed and versioned like code | No runtime admin changes |
| 10 | **Kubernetes + Kustomize** | Self-healing, rolling deploys, per-service autoscaling | Operational complexity |
| 11 | **Better Auth** for authentication (planned), our own permission matrix for authorization | Proven auth flows, sessions, organisations and key rotation without hand-written security code | Library upgrades need care. Two-surface setup needs a spike ([Auth.md §15](../design/Auth.md#15-risks-and-spikes)) |

---

## 16. Known gaps

Issues found while running the system, listed so nobody builds on false assumptions.

| Area | Gap | Impact |
|---|---|---|
| realtime-gateway | Kafka producer is never connected | The first `location:update` crashes the process |
| realtime-gateway | `EXPIRE` on the whole `drivers:geo` key | Stale drivers don't expire individually |
| Events | Only auth-service has an outbox (and relay) so far | Other services can lose events if Kafka is down after a commit |
| Compose stack mode | Redpanda advertises `localhost:9092`; root `.env` points containers at `localhost` | Containerized services can't reach Kafka or Redis |
| Delivery | Kubernetes manifests use `:latest`; deploy jobs lack cluster credentials; only trip-service has manifests; `.github/` is gitignored | CD doesn't deploy new code yet |
| Infra | `infra/terraform/modules/` is empty; RDS pinned to Postgres 16 vs 18 locally | `terraform init` fails; dev/prod parity gap |
| Services | trip, location, pricing, payment and mapping expose `/health` only | The flows in [§5.2](#52-request-a-trip-target-design) and [§5.4](#54-trip-completion-and-payment-target-design) are designs, not code |

When you close a gap, update this table and the status markers in [§3](#3-services-and-ownership) and [§8](#8-event-catalog).
