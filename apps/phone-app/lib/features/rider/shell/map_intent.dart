// What the rider's one map should show at each stage of the flow, as plain data the shell reads.
//
// The rider map shell (rider_map_shell.dart) keeps a single AnbessaMap alive from home to the end
// of a trip. Each stage (home, search, choose ride, trip) contributes a MapIntent through its own
// provider here, derived from app state only (booking, trip, live driver position, the pin
// picker), so nothing is written to a provider while a widget builds and a rebuild never moves
// the camera by itself: the camera refits only when an intent's `fitKey` changes. Things that
// move every frame (the driver's car, the nearby cars, the sheet height) are not in the intent;
// the shell owns their animators and hands them to the map as listenables.

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/location/location_source.dart';
import '../../../core/state.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../booking/booking_controller.dart';
import '../booking/pin_picker.dart';
import '../trip/active_trip_controller.dart';
import '../trip/trip_eta_controller.dart';

enum RiderMapStageKind { home, search, quote, trip }

/// Which stage of the rider flow a location is, for the shell.
@immutable
class RiderMapStage {
  const RiderMapStage(this.kind, {this.tripId, this.focusPickup = false});
  final RiderMapStageKind kind;
  final String? tripId;
  /// search: the pickup field has the focus (else the drop-off)
  final bool focusPickup;

  static const home = RiderMapStage(RiderMapStageKind.home);

  /// `/rider/book/route?focus=pickup` → search (pickup); `/rider/book/quote` → quote;
  /// `/rider/trip/<id>[/…]` → trip; anything else → home.
  static RiderMapStage fromUri(Uri uri) {
    final seg = uri.pathSegments;
    if (seg.length >= 3 && seg[0] == 'rider' && seg[1] == 'book') {
      if (seg[2] == 'quote') return const RiderMapStage(RiderMapStageKind.quote);
      if (seg[2] == 'route') return RiderMapStage(RiderMapStageKind.search, focusPickup: uri.queryParameters['focus'] == 'pickup');
    }
    if (seg.length >= 3 && seg[0] == 'rider' && seg[1] == 'trip') return RiderMapStage(RiderMapStageKind.trip, tripId: seg[2]);
    return home;
  }

  @override
  bool operator ==(Object other) => other is RiderMapStage && other.kind == kind && other.tripId == tripId && other.focusPickup == focusPickup;
  @override
  int get hashCode => Object.hash(kind, tripId, focusPickup);
  @override
  String toString() => 'RiderMapStage(${kind.name}${tripId == null ? '' : ' $tripId'})';
}

enum IntentCalloutKind { minutes, arriveAt }

/// A label on the map, as data: the shell writes the words ("4 min", "Arrive 14:32").
@immutable
class IntentCallout {
  const IntentCallout.minutes(this.point, int this.minutes) : kind = IntentCalloutKind.minutes, time = null;
  const IntentCallout.arriveAt(this.point, DateTime this.time) : kind = IntentCalloutKind.arriveAt, minutes = null;
  final LatLng point;
  final IntentCalloutKind kind;
  final int? minutes;
  final DateTime? time;

  @override
  bool operator ==(Object other) => other is IntentCallout && other.point == point && other.kind == kind && other.minutes == minutes && other.time == time;
  @override
  int get hashCode => Object.hash(point, kind, minutes, time);
}

/// What the map shows for one stage.
@immutable
class MapIntent {
  const MapIntent({
    this.fit = const [],
    this.fitKey,
    this.pickup,
    this.dropoff,
    this.routes = const [],
    this.revealKey,
    this.nearby = false,
    this.car = false,
    this.carMinutes,
    this.carRoad,
    this.follow = FollowMode.none,
    this.followZoom = 15,
    this.callouts = const [],
    this.radarAt,
    this.pin = false,
    this.controls = true,
    this.meAvatar = false,
    this.showMe = true,
  });

  /// points the camera fits (when [fitKey] changes)
  final List<LatLng> fit;
  final Object? fitKey;
  final LatLng? pickup;
  final LatLng? dropoff;
  final List<RouteLine> routes;
  /// a new value draws the first route progressively (the choose-ride reveal); null draws at once
  final Object? revealKey;
  /// the animated cars around the rider
  final bool nearby;
  /// the trip's car (the shell's animator)
  final bool car;
  /// "N min" above the car
  final int? carMinutes;
  /// the road the car is snapped to while it drives
  final List<GeoPoint>? carRoad;
  final FollowMode follow;
  final double followZoom;
  final List<IntentCallout> callouts;
  /// the "finding a driver" rings around the rider's avatar (drawn there instead of the pickup pin)
  final LatLng? radarAt;
  /// drag-to-pick: the camera centre is the place, no insets
  final bool pin;
  /// the map's own controls (2D/3D, recenter)
  final bool controls;
  /// the rider drawn as their avatar pin (home) rather than a small dot
  final bool meAvatar;
  /// the rider's own position at all (not where the pickup avatar already stands for them)
  final bool showMe;

  @override
  bool operator ==(Object other) =>
      other is MapIntent &&
      listEquals(other.fit, fit) &&
      other.fitKey == fitKey &&
      other.pickup == pickup &&
      other.dropoff == dropoff &&
      sameRoutes(other.routes, routes) &&
      other.revealKey == revealKey &&
      other.nearby == nearby &&
      other.car == car &&
      other.carMinutes == carMinutes &&
      identical(other.carRoad, carRoad) &&
      other.follow == follow &&
      other.followZoom == followZoom &&
      listEquals(other.callouts, callouts) &&
      other.radarAt == radarAt &&
      other.pin == pin &&
      other.controls == controls &&
      other.meAvatar == meAvatar &&
      other.showMe == showMe;

  @override
  int get hashCode => Object.hash(fitKey, pickup, dropoff, routes.length, revealKey, nearby, car, carMinutes, follow, pin, radarAt, callouts.length);
}

/// Route lists are equal when each line has the same kind and the same points (decoded lines are
/// memoised, so this is usually an identity check).
bool sameRoutes(List<RouteLine> a, List<RouteLine> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].kind != b[i].kind) return false;
    if (!identical(a[i].points, b[i].points) && !listEquals(a[i].points, b[i].points)) return false;
  }
  return true;
}

// ── shared helpers ──────────────────────────────────────────────────────────

/// A polyline (precision 6) decoded once while anything uses it.
final decodedRouteProvider = Provider.autoDispose.family<List<LatLng>, String>((ref, polyline6) {
  if (polyline6.isEmpty) return const [];
  return List.unmodifiable(decodePolyline6(polyline6).map((p) => LatLng(p.lat, p.lng)));
});

/// The part of [points] from the start to [t] (0–1) of its length, for drawing a line as it grows.
List<LatLng> routePrefix(List<LatLng> points, double t) {
  if (points.length < 2 || t >= 1) return points;
  if (t <= 0) return [points.first, points.first];
  final geo = [for (final p in points) (lat: p.latitude, lng: p.longitude)];
  final cum = cumulativeMeters(geo);
  final target = cum.last * t;
  final out = <LatLng>[points.first];
  for (var i = 1; i < points.length; i++) {
    if (cum[i] >= target) {
      final seg = cum[i] - cum[i - 1];
      final f = seg <= 0 ? 0.0 : (target - cum[i - 1]) / seg;
      final p = geoLerp(geo[i - 1], geo[i], f);
      out.add(LatLng(p.lat, p.lng));
      return out;
    }
    out.add(points[i]);
  }
  return out;
}

/// When the rider gets there if they leave now: the car's [etaSeconds] to the pickup plus the
/// ride's [durationSeconds], in local time.
DateTime arriveAt(DateTime now, {required int etaSeconds, required int durationSeconds}) => now.toLocal().add(Duration(seconds: etaSeconds + durationSeconds));

/// "14:32" (24-hour, local).
String clockHHmm(DateTime t) {
  final l = t.toLocal();
  return '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
}

/// Whole minutes for a label, at least 1.
int minutesCeil(int seconds) => (seconds / 60).ceil().clamp(1, 999);

// ── the rider's own position ────────────────────────────────────────────────

/// The rider's position as it changes (the blue dot), while the map shell is on screen. Each fix
/// is also kept in [lastPositionProvider]. Null until permission is given and a first fix lands.
final riderLocationProvider = StreamProvider.autoDispose<DevicePosition?>((ref) async* {
  final src = ref.watch(locationSourceProvider);
  try {
    final perm = await src.ensurePermission(LocationProfile.once);
    ref.read(riderLocationPermissionProvider.notifier).set(perm);
    if (perm != LocationPermissionState.granted) {
      yield ref.read(lastPositionProvider);
      return;
    }
  } catch (_) {
    yield ref.read(lastPositionProvider);
    return;
  }
  final last = ref.read(lastPositionProvider);
  if (last != null) yield last;
  try {
    await for (final p in src.watch(LocationProfile.rider)) {
      ref.read(lastPositionProvider.notifier).set(p);
      yield p;
    }
  } catch (_) {
    // the platform stream failed (no plugin on this platform): keep the last fix
  }
});

/// What the phone answered when the map shell asked for the rider's location (null until asked):
/// the home stage offers "Enable Location" when it isn't granted.
final riderLocationPermissionProvider = valueProvider<LocationPermissionState?>(null);

/// Home is still waiting for the rider's first position (permission given or not yet asked):
/// "Searching your location...".
final riderLocatingProvider = Provider.autoDispose<bool>((ref) {
  final perm = ref.watch(riderLocationPermissionProvider);
  if (perm != null && perm != LocationPermissionState.granted) return false;
  if (ref.watch(lastPositionProvider) != null) return false;
  return ref.watch(riderLocationProvider).value == null;
});

/// The served city around the rider (their position's city, else the first served city): search
/// is biased to it and its common places are offered.
final riderCityProvider = Provider<City>((ref) {
  final cfg = ref.watch(configProvider);
  final me = ref.watch(lastPositionProvider);
  return (me == null ? null : cfg.cityAt(me.lat, me.lng)) ?? ref.watch(currentCityProvider);
});

// ── stage intents ───────────────────────────────────────────────────────────

/// Home: the rider in the middle, the cars around them.
final homeMapIntentProvider = Provider<MapIntent>((ref) => const MapIntent(follow: FollowMode.me, followZoom: 15, nearby: true, meAvatar: true));

/// Search: the chosen places (the sheet covers most of the map); in pin mode, the camera centre.
final searchMapIntentProvider = Provider<MapIntent>((ref) {
  final pin = ref.watch(pinPickerProvider);
  if (pin.active) return MapIntent(pin: true, fit: [pin.start], fitKey: ('pin', pin.session), controls: false, showMe: false);
  final b = ref.watch(bookingProvider);
  final pickup = b.pickup == null ? null : LatLng(b.pickup!.lat, b.pickup!.lng);
  final dropoff = b.dropoff == null ? null : LatLng(b.dropoff!.lat, b.dropoff!.lng);
  if (pickup == null && dropoff == null) return const MapIntent(follow: FollowMode.me, followZoom: 15, controls: false, meAvatar: true);
  return MapIntent(pickup: pickup, dropoff: dropoff, fit: [?pickup, ?dropoff], fitKey: ('search', pickup, dropoff), controls: false);
});

/// The last road a quote came with, so a re-quote keeps it on the map (dimmed) until the new one.
class LastQuoteRoute extends Notifier<QuoteRoute?> {
  @override
  QuoteRoute? build() {
    ref.listen(bookingProvider.select((b) => b.route), (_, r) {
      if (r != null && r.polyline6.isNotEmpty) state = r;
    });
    final r = ref.read(bookingProvider).route;
    return r != null && r.polyline6.isNotEmpty ? r : null;
  }
}

final lastQuoteRouteProvider = NotifierProvider<LastQuoteRoute, QuoteRoute?>(LastQuoteRoute.new);

/// Choose ride: the road (drawn as it grows), the pins, "N min" at the pickup and "Arrive HH:MM"
/// at the drop-off; fitted above the sheet whenever the road or the places change.
final quoteMapIntentProvider = Provider<MapIntent>((ref) {
  final b = ref.watch(bookingProvider);
  final pickup = b.pickup == null ? null : LatLng(b.pickup!.lat, b.pickup!.lng);
  final dropoff = b.dropoff == null ? null : LatLng(b.dropoff!.lat, b.dropoff!.lng);
  if (pickup == null || dropoff == null) return const MapIntent(follow: FollowMode.me, controls: false, meAvatar: true);
  final poly = b.route?.polyline6 ?? '';
  final live = poly.isEmpty ? const <LatLng>[] : ref.watch(decodedRouteProvider(poly));
  final previous = ref.watch(lastQuoteRouteProvider);
  // re-quoting: the old road stays, dimmed, until the new one arrives
  final stale = live.isEmpty && b.quoting && previous != null ? ref.watch(decodedRouteProvider(previous.polyline6)) : const <LatLng>[];
  final road = live.length >= 2
      ? RouteLine(live)
      : stale.length >= 2
          ? RouteLine(stale, kind: RouteKind.secondary)
          : RouteLine.straight(pickup, dropoff);
  final q = b.quote;
  final etas = [for (final x in b.quotes) x.etaToPickupSeconds].whereType<int>();
  final minEta = etas.isEmpty ? null : etas.reduce((a, c) => a < c ? a : c);
  final callouts = <IntentCallout>[
    if (minEta != null && !b.scheduling) IntentCallout.minutes(pickup, minutesCeil(minEta)),
    if (q != null && !b.scheduling) IntentCallout.arriveAt(dropoff, arriveAt(DateTime.now(), etaSeconds: q.etaToPickupSeconds ?? minEta ?? 0, durationSeconds: q.durationSeconds)),
  ];
  return MapIntent(
    pickup: pickup,
    dropoff: dropoff,
    routes: [road],
    revealKey: live.length >= 2 ? poly : null,
    fit: live.length >= 2 ? live : [pickup, dropoff],
    fitKey: ('quote', pickup, dropoff, live.length >= 2),
    callouts: callouts,
    // the pickup avatar is the rider here
    showMe: false,
  );
});

/// What the trip screen and its map share: the stage, the car's last sample and its ETA.
@immutable
class TripView {
  const TripView({required this.trip, required this.stage, this.live, this.etaSeconds});
  final Trip trip;
  final RiderStage stage;
  final DriverLive? live;
  /// to the pickup (assigned) or the drop-off (riding)
  final int? etaSeconds;
  bool get tracking => trip.driver != null && trip.isActive;
  bool get driving => stage == RiderStage.driverAssigned || stage == RiderStage.inTrip;
}

final tripViewProvider = Provider.autoDispose.family<TripView?, String>((ref, id) {
  final t = ref.watch(tripProvider(id)).value;
  if (t == null) return null;
  final stage = riderStageOf(t);
  final tracking = t.driver != null && t.isActive;
  final live = tracking ? ref.watch(driverLiveProvider(id)).value : null;
  final eta = ref.watch(tripEtaProvider(id));
  final target = stage == RiderStage.inTrip ? t.dropoff : t.pickup;
  final driving = stage == RiderStage.driverAssigned || stage == RiderStage.inTrip;
  // a straight-line guess (city speed, roads 35 % longer) until the road ETA arrives
  final etaSeconds = !driving ? null : (eta?.seconds ?? (live == null ? null : (haversineMeters(live.lat, live.lng, target.lat, target.lng) * 1.35 / 6.1).round()));
  return TripView(trip: t, stage: stage, live: live, etaSeconds: etaSeconds);
});

/// The trip: the pulse while finding a driver; the car with its road to the pickup; the ride's
/// road split into driven (grey) and ahead; "Arrive HH:MM" at the drop-off while riding. The
/// camera refits on each stage (and when the car's road first arrives), not as the car moves.
final tripMapIntentProvider = Provider.autoDispose.family<MapIntent, String>((ref, id) {
  final v = ref.watch(tripViewProvider(id));
  if (v == null) return const MapIntent();
  final t = v.trip;
  final stage = v.stage;
  final pickup = LatLng(t.pickup.lat, t.pickup.lng);
  final dropoff = LatLng(t.dropoff.lat, t.dropoff.lng);
  final tripPoly = t.route.polyline ?? '';
  final tripPts = ref.watch(decodedRouteProvider(tripPoly));
  final live = v.live;
  final carPt = live == null ? null : LatLng(live.lat, live.lng);
  final eta = v.driving ? ref.watch(tripEtaProvider(id)) : null;
  final carPts = eta == null || eta.polyline6.isEmpty || carPt == null ? const <LatLng>[] : ref.watch(decodedRouteProvider(eta.polyline6));

  final routes = <RouteLine>[];
  List<GeoPoint>? carRoad;
  switch (stage) {
    case RiderStage.driverAssigned:
      if (tripPts.length >= 2) routes.add(RouteLine(tripPts, kind: RouteKind.secondary));
      if (carPts.length >= 2) {
        routes.add(RouteLine(carPts));
        carRoad = ref.watch(_geoRouteProvider(eta!.polyline6));
      } else if (carPt != null) {
        routes.add(RouteLine.straight(carPt, pickup));
      }
    case RiderStage.inTrip:
      if (tripPts.length >= 2) {
        final geo = ref.watch(_geoRouteProvider(tripPoly));
        carRoad = geo;
        if (carPt != null) {
          // driven (grey) and ahead (amber), split where the car is on the road
          final at = projectOntoPolyline(geo, (lat: carPt.latitude, lng: carPt.longitude));
          final driven = sliceTo(geo, at);
          final ahead = sliceFrom(geo, at);
          if (driven.length >= 2) routes.add(RouteLine([for (final p in driven) LatLng(p.lat, p.lng)], kind: RouteKind.traversed));
          routes.add(RouteLine([for (final p in ahead) LatLng(p.lat, p.lng)]));
        } else {
          routes.add(RouteLine(tripPts));
        }
      } else {
        routes.add(RouteLine.straight(pickup, dropoff));
      }
    default:
      routes.add(tripPts.length >= 2 ? RouteLine(tripPts) : RouteLine.straight(pickup, dropoff));
  }

  final fit = switch (stage) {
    // the rings around the rider, in the middle
    RiderStage.finding => [pickup],
    RiderStage.driverAssigned || RiderStage.driverArrived => [pickup, ?carPt],
    RiderStage.inTrip => [?carPt, dropoff],
    _ => tripPts.length >= 2 ? tripPts : [pickup, dropoff],
  };
  return MapIntent(
    // a plain pickup pin (no photo once booked), in the search rings while finding a driver;
    // gone once the rider is in the car
    pickup: stage == RiderStage.inTrip ? null : pickup,
    dropoff: dropoff,
    routes: routes,
    fit: fit,
    fitKey: ('trip', id, stage, carPts.length >= 2, carPt != null),
    car: v.tracking,
    carMinutes: v.driving && carPt != null && v.etaSeconds != null ? minutesCeil(v.etaSeconds!) : null,
    carRoad: carRoad,
    radarAt: stage == RiderStage.finding ? pickup : null,
    // the rider's own dot only while they walk to the car
    showMe: stage == RiderStage.driverAssigned || stage == RiderStage.driverArrived,
    callouts: [
      if (stage == RiderStage.inTrip && v.etaSeconds != null) IntentCallout.arriveAt(dropoff, DateTime.now().add(Duration(seconds: v.etaSeconds!))),
    ],
  );
});

/// The same polyline as GeoPoints, decoded once (the car animator's road).
final _geoRouteProvider = Provider.autoDispose.family<List<GeoPoint>, String>((ref, polyline6) => polyline6.isEmpty ? const [] : List.unmodifiable(decodePolyline6(polyline6)));
