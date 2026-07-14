// Mirrors libs/shared-types/src/trip.ts on the backend — keep field names
// in sync manually, or generate this from the OpenAPI/JSON schema if the
// project grows enough to justify codegen.
enum TripStatus { requested, matched, enRoute, inProgress, completed, cancelled }

class Trip {
  Trip({required this.id, required this.status, required this.originLat, required this.originLng});
  final String id;
  final TripStatus status;
  final double originLat;
  final double originLng;
}
