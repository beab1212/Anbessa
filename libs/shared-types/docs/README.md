# `@ride-app/shared-types`

Shared TypeScript contracts: Kafka event payloads, the trip DTO and a few enums. The point is that a producer and a consumer in two different services import the same type, so they can't drift apart silently (comment at the top of [`src/events.ts`](../src/events.ts)).

| File | What it covers |
|---|---|
| [reference.md](reference.md) | Every exported type and constant, field by field |
| [event-catalog.md](event-catalog.md) | Every Kafka topic in the repo: key, producer, payload, consumers, and whether its payload type lives here |

---

## What belongs here and what doesn't

Belongs here:

- payload types of events that cross a service boundary (producer in one service, consumer in another);
- response shapes that a client (the web app) reads from a service (`Trip`);
- small enums and constants several packages must agree on (`PaymentMethod`, `BalanceState`, `RATING_TAGS`).

Does not belong here:

- runtime validation. The lib has no dependencies and ships no zod schemas. Consumers validate payloads themselves (location-service `src/events/handlers.ts`, payment-service `src/events/consumer.ts`, fleet-service `src/events/consumer.ts` use zod);
- service-internal types (Prisma models, repository types);
- Dart models. The phone app mirrors `Trip` by hand in `packages/core/lib/src/models/trip.dart` (the comment in `trip.ts` says `packages/core/lib/models/trip.dart`, the file is under `lib/src/models/`). Change both in the same PR.

**Coverage today.** Not every topic has a type here. auth-service and fleet-service (except `driver.online` / `driver.offline`) declare their payloads locally in their `src/outbox/outbox.ts` as a discriminated union. See [event-catalog.md](event-catalog.md) for which is which.

## Who uses it

From `grep -r '@ride-app/shared-types'` over `services/` and `apps/` (source and test files):

| Package | Files | Symbols |
|---|---|---|
| `services/payment-service` | 8 | `TripCompletedEvent`, `TripCancelledEvent` (consumer), `BalanceStateChangedEvent`, `BalanceMoneyEvent`, `PaymentActionRequiredEvent`, `PaymentOutcomeEvent`, `RefundOutcomeEvent`, `TripSettledEvent`, `EventEnvelope` (outbox), `Beneficiary`, `BalanceState`, `PaymentMethod` |
| `services/trip-service` | 2 | `EventEnvelope`, `TripRequestedEvent`, `TripMatchedEvent`, `TripProgressEvent`, `TripCompletedEvent`, `TripCancelledEvent` (outbox), `RATING_TAGS`, `Beneficiary`, `PaymentMethod` |
| `services/realtime-gateway` | 3 | `DriverLocationEvent` |
| `services/fleet-service` | 1 | `DriverOnlineEvent`, `DriverOfflineEvent`, `EventEnvelope` (outbox) |
| `services/location-service` | 1 | `DriverConnectionLostEvent` |
| `apps/web` | 5 | `Trip` |

`package.json` dependencies also list it in auth-service, mapping-service and notification-service, which don't import it. notification-service declares its own loose `EventEnvelope` (`src/notify/handlers.ts`) and reads fields untyped.

Exports not imported anywhere: `UserCreatedEvent`, `TripEndedEvent` (only as a base interface), `TripStatus`, `TripPlace` (only through `Trip`), `Role`, `PublicUser`.

## Build and import

Same layout as the other libs ([`package.json`](../package.json)):

```json
"exports": { ".": { "development": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
```

- With the `development` condition (`tsx --conditions=development` in `pnpm dev`, `tsc --customConditions development` in service typechecks, `customConditions` in `apps/web/tsconfig.json`) the TypeScript source is used directly.
- Otherwise `dist/` is used; build with `pnpm build` (`tsc -p tsconfig.json`, extends [`tsconfig.base.json`](../../../tsconfig.base.json)).
- Scripts: `build`, `lint` (`eslint src`), `typecheck` (`tsc --noEmit`). No `test` script and no tests.
- No dependencies. ESM (`"type": "module"`).

Almost everything is a type, so imports should be `import type` where possible. The only runtime export is `RATING_TAGS`.

```ts
import type { TripCompletedEvent, EventEnvelope } from "@ride-app/shared-types";
import { RATING_TAGS } from "@ride-app/shared-types";
```

## How producers use the event types

Producers type the payload **without** the envelope and add it when writing the outbox row. From `services/trip-service/src/outbox/outbox.ts`:

```ts
type Body<T> = Omit<T, keyof EventEnvelope>;

export type TripEvent =
  | { topic: "trip.requested"; payload: Body<TripRequestedEvent> }
  | { topic: "trip.matched"; payload: Body<TripMatchedEvent> }
  | { topic: "trip.driver_en_route" | "trip.driver_arrived" | "trip.started"; payload: Body<TripProgressEvent> }
  | { topic: "trip.completed"; payload: Body<TripCompletedEvent> }
  | { topic: "trip.cancelled"; payload: Body<TripCancelledEvent> };

export async function writeOutbox(tx: Prisma.TransactionClient, event: TripEvent): Promise<void> {
  const payload = { eventId: uuidv7(), version: 1, at: new Date().toISOString(), ...event.payload };
  await tx.outbox.create({ data: { topic: event.topic, key: event.payload.tripId, payload } });
}
```

The same `Body<T>` + `{ eventId: uuidv7(), version: 1, at }` pattern is in payment-service and fleet-service. location-service adds the envelope directly before `producer.send` (`src/events/kafka.ts`). Every producer in the repo sends `version: 1`.

## Source map

| File | Exports |
|---|---|
| [`src/events.ts`](../src/events.ts) | `EventEnvelope`, `DriverLocationEvent`, `DriverOnlineEvent`, `DriverOfflineEvent`, `DriverConnectionLostEvent`, `TripMatchedEvent`, `PaymentMethod`, `Beneficiary`, `TripRequestedEvent`, `TripProgressEvent`, `TripEndedEvent`, `TripCompletedEvent`, `TripCancelledEvent`, `UserCreatedEvent`, `BalanceState`, `BalanceStateChangedEvent`, `PaymentActionRequiredEvent`, `PaymentOutcomeEvent`, `TripSettledEvent`, `BalanceMoneyEvent`, `RefundOutcomeEvent` |
| [`src/trip.ts`](../src/trip.ts) | `TripStatus`, `TripPlace`, `Trip`, `RATING_TAGS` |
| [`src/user.ts`](../src/user.ts) | `Role`, `PublicUser` |
