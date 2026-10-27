# @ride-app/shared-settings

The registry of live platform settings (keys, types, bounds, defaults, city scope, sensitivity) and the client every service uses to read them from platform-service (snapshot at start, Redis `settings:changed`, 30 s poll, synchronous `get`).

Full documentation: [docs/README.md](docs/README.md).
