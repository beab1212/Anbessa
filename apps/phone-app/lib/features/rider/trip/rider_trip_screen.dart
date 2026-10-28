// The trip stage in the rider map shell (workflows 05 D–E, 06, 07), drawn as the GoRide kit's
// trip screens: finding a driver (the rings around the rider's avatar at the pickup, "Finding you
// a nearby driver...", the time spent searching, Cancel Ride) → the driver heading to the pickup
// (the white car gliding along its road with "N min" over it; the sheet: "Driver is heading to
// your location...", "Driver will arrive in N min...", the car and plate, the driver's photo,
// name and rating (a tap opens Driver Information), the trip PIN, the ride and fare cards, Cancel
// Ride) → arrived → heading to the destination ("Arrive HH:MM"; the road behind turns grey) →
// "You have arrived!" over the dimmed map (duration, distance, average speed, the fare, Finish),
// or "Ride has been canceled!". The route card, share and SOS float over the map. The map is the
// shell's (map_intent.dart: tripMapIntentProvider); this file is the sheet, the top bar and the
// end of the trip. Clocks (time searching, the free-cancel window, a stale position) tick in
// their own small widgets: nothing here rebuilds every second.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:share_plus/share_plus.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../../shell/shells.dart' show bannerHeightProvider;
import '../booking/quote_screen.dart' show vehicleName;
import '../shell/map_intent.dart';
import '../shell/rider_map_shell.dart';
import 'active_trip_controller.dart';
import 'cancel_sheet.dart';
import 'trip_eta_controller.dart';

const _cancelFeeMinor = 3000;

class TripSheet extends ConsumerStatefulWidget {
  const TripSheet({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<TripSheet> createState() => _TripSheetState();
}

class _TripSheetState extends ConsumerState<TripSheet> {
  RiderStage? _lastStage;

  /// A new stage: haptics, a word, confetti at the end; the sheet settles at its resting size.
  void _onStage(RiderStage stage) {
    if (_lastStage == stage) return;
    final first = _lastStage == null;
    _lastStage = stage;
    if (first) return;
    final shell = RiderMapScope.maybeOf(context);
    shell?.sheet.animateTo(0, duration: AnbessaMotion.of(context, AnbessaMotion.sheet));
    switch (stage) {
      case RiderStage.driverAssigned || RiderStage.inTrip:
        Haptics.success();
      case RiderStage.driverArrived:
        Haptics.offer();
        showToast(context, context.l10n.driverArrivedLede, tone: NoticeTone.ok, icon: Icons.directions_car_rounded);
      case RiderStage.completed:
        Haptics.success();
        shell?.confetti.play();
      case RiderStage.cancelled:
        Haptics.error();
      default:
        break;
    }
  }

  /// Each position of the car: to its animator on the map, and to the ETA (which decides itself
  /// whether a new road is worth asking for).
  void _onLive(DriverLive live) {
    final v = ref.read(tripViewProvider(widget.tripId));
    if (v == null || !v.tracking) return;
    RiderMapScope.maybeOf(context)?.carFor(widget.tripId).push((lat: live.lat, lng: live.lng), heading: live.heading, speed: live.speed, at: live.at);
    if (v.driving) {
      final target = v.stage == RiderStage.inTrip ? v.trip.dropoff : v.trip.pickup;
      ref.read(tripEtaProvider(widget.tripId).notifier).track((lat: live.lat, lng: live.lng), (lat: target.lat, lng: target.lng));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    // dispatch gave the trip to another driver
    ref.listen(activeTripProvider, (prev, next) {
      final before = prev?.value;
      final now = next.value;
      if (before == null || now == null || before.id != widget.tripId || now.id != widget.tripId) return;
      final was = before.driver?.userId;
      final isNow = now.driver?.userId;
      if (was != null && isNow != null && was != isNow) {
        Haptics.offer();
        showToast(context, l.driverChanged, tone: NoticeTone.info);
      }
    });
    final view = ref.watch(tripViewProvider(widget.tripId));
    if (view == null) {
      final async = ref.watch(tripProvider(widget.tripId));
      return async.hasError ? Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(tripProvider(widget.tripId)), retryLabel: l.retry) : const SkeletonList(rows: 3);
    }
    final t = view.trip;
    final stage = view.stage;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _onStage(stage);
    });
    if (view.tracking) {
      ref.listen(driverLiveProvider(t.id), (_, next) {
        final live = next.value;
        if (live != null) _onLive(live);
      });
      // the first sample may have landed before the listener: start the car from it
      final live = view.live;
      final car = RiderMapScope.maybeOf(context)?.carFor(t.id);
      if (live != null && car != null && car.pose == null) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && car.pose == null) _onLive(live);
        });
      }
    }
    final parties = t.driver == null ? null : ref.watch(tripPartiesProvider(t.id)).value;
    final pinOn = ref.watch(featureProvider(Feature.tripPin));
    return SharedAxisSwitcher(
      child: KeyedSubtree(
        key: ValueKey(stage),
        child: switch (stage) {
          RiderStage.finding => _Finding(trip: t),
          RiderStage.driverAssigned || RiderStage.driverArrived || RiderStage.inTrip => _DriverStage(
              trip: t, stage: stage, parties: parties, live: view.live, etaSeconds: view.etaSeconds, pinOn: pinOn),
          // the end of the trip covers the shell (TripEndLayer); the sheet waits under it
          RiderStage.completed || RiderStage.cancelled => const SizedBox(height: 120),
          RiderStage.unknown => Text(tripStatusLabel(l, t.status)),
        },
      ),
    );
  }
}

/// Pinned under the trip sheet while a driver is being found: Cancel Ride, always on screen
/// whatever the text size (the sheet's content scrolls above it).
class TripSheetFooter extends ConsumerWidget {
  const TripSheetFooter({super.key, required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = ref.watch(tripViewProvider(tripId));
    if (v == null || v.stage != RiderStage.finding) return const SizedBox.shrink();
    return CancelRideButton(trip: v.trip, showFee: false);
  }
}

/// The kit's red-outlined "Cancel Ride": the reasons sheet, then POST /api/trips/:id/cancel with
/// the reason (one idempotency key per trip and reason, so a retry is the same cancel). The trip
/// that comes back replaces the active one: its stage turns to cancelled and the shell shows "Ride
/// has been canceled!". A refusal is said above the button and the trip stays. Under it, the fee
/// once the free window has closed (checked every few seconds).
class CancelRideButton extends ConsumerStatefulWidget {
  const CancelRideButton({super.key, required this.trip, this.showFee = true});
  final Trip trip;
  final bool showFee;
  @override
  ConsumerState<CancelRideButton> createState() => _CancelRideButtonState();
}

class _CancelRideButtonState extends ConsumerState<CancelRideButton> {
  bool _busy = false;
  Object? _error;
  (String, CancelReason, String)? _key;

  Future<void> _cancel() async {
    if (_busy) return;
    final t = widget.trip;
    final free = riderCancelIsFree(t, DateTime.now().toUtc());
    // read before the sheet: a stage change while it is open (the driver arrives) rebuilds the
    // sheet's content and this button with it, and the rider's choice must still be sent
    final apis = ref.read(apisProvider);
    final active = ref.read(activeTripProvider.notifier);
    final reason = await showCancelSheet(context, free: free, feeMinor: _cancelFeeMinor);
    if (reason == null) return;
    final k = _key;
    final key = k != null && k.$1 == t.id && k.$2 == reason ? k.$3 : newIdempotencyKey();
    _key = (t.id, reason, key);
    if (mounted) {
      setState(() {
        _busy = true;
        _error = null;
      });
    }
    try {
      final u = await apis.trips.cancel(t.id, reason, idempotencyKey: key);
      active.replace(u);
    } catch (e) {
      Haptics.error();
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Problem(_error, describe: (e) => describeError(l, e)),
        PillButton(key: const ValueKey('cancel-ride'), label: l.grCancelRide, variant: PillVariant.outlineDanger, busy: _busy, onPressed: _busy ? null : _cancel),
        if (widget.showFee)
          TickingBuilder(
            interval: const Duration(seconds: 5),
            builder: (context, now) => riderCancelIsFree(widget.trip, now.toUtc())
                ? const SizedBox.shrink()
                : Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.cancelFeeWarning(birr(_cancelFeeMinor, locale: context.localeTag)), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted))),
          ),
      ],
    );
  }
}

/// Over the map during a trip: the route card (pickup, destination), and share and SOS under it.
class TripTopBar extends ConsumerWidget {
  const TripTopBar({super.key, required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final t = ref.watch(tripProvider(tripId)).value;
    final sosOn = ref.watch(featureProvider(Feature.sos));
    if (t == null || !t.isActive) return const SizedBox.shrink();
    final share = t.status != TripStatus.requested;
    // SOS on a trip with a driver, and for 30 min after drop-off (support-service's window)
    final sos = sosOn && sosAvailable(t, DateTime.now());
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        RoutePointsCard(points: [RoutePointsCard.pickup(t.pickup.address ?? l.pickupLabel), RoutePointsCard.destination(t.dropoff.address ?? l.dropoffLabel)]),
        if (share || sos) ...[
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              if (share) _ShareButton(tripId: t.id),
              if (share && sos) const SizedBox(width: 10),
              if (sos) RoundIconButton(icon: Icons.sos_rounded, tooltip: l.sos, danger: true, onTap: () => context.push('${Routes.sos}?trip=${t.id}')),
            ],
          ),
        ],
      ],
    );
  }
}

/// A centred headline, a grey line under it (and an optional third), as the kit's trip sheets.
class _Headline extends StatelessWidget {
  const _Headline({required this.title, this.lede, this.extra});
  final String title;
  final String? lede;
  final Widget? extra;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 6),
        Semantics(header: true, liveRegion: true, child: Text(title, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text))),
        if (lede != null) ...[const SizedBox(height: 8), Text(lede!, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.muted, fontWeight: FontWeight.w400))],
        if (extra != null) ...[const SizedBox(height: 4), extra!],
      ],
    );
  }
}

class _Finding extends StatelessWidget {
  const _Finding({required this.trip});
  final Trip trip;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Headline(
          title: l.grFindingDriver,
          lede: l.grFindingDriverLede,
          extra: ElapsedText(
            key: const ValueKey('searching-for'),
            since: trip.times.requestedAt,
            format: (d) => l.grSearchingFor(mmss(d)),
            textAlign: TextAlign.center,
            style: AnbessaType.caption.copyWith(color: c.faint, fontFeatures: AnbessaType.tabular),
          ),
        ),
        const SizedBox(height: 16),
        const Center(child: LocatingDot()),
        // Cancel Ride is the sheet's footer here (TripSheetFooter): always on screen
      ],
    );
  }
}

/// The driver's photo, flying to the pay and rating pages.
class _DriverAvatar extends StatelessWidget {
  const _DriverAvatar({required this.tripId, required this.photo, required this.name});
  final String tripId;
  final String? photo;
  final String name;
  @override
  Widget build(BuildContext context) => Hero(tag: driverAvatarHeroTag(tripId), child: AvatarImage(src: photo, name: name, size: 52));
}

/// "Hyundai Atos, Blue · 3-A40402".
String vehicleLine(PartyVehicle v) {
  final car = [v.make, v.model].where((s) => s.isNotEmpty).join(' ');
  final named = [car, v.color].where((s) => s.isNotEmpty).join(', ');
  return [named, v.plateNumber].where((s) => s.isNotEmpty).join(' · ');
}

/// The kit's driver row: photo, name, ★ rating; a tap opens Driver Information.
class _DriverLine extends StatelessWidget {
  const _DriverLine({required this.trip, required this.parties});
  final Trip trip;
  final TripParties? parties;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final name = parties?.driverName ?? l.driverLabel;
    final rating = parties?.driverRating;
    final meta = AnbessaType.caption.copyWith(color: c.muted);
    return Semantics(
      button: true,
      label: l.grDriverDetails,
      child: InkWell(
        borderRadius: BorderRadius.circular(AnbessaRadius.md),
        onTap: () => Navigator.of(context, rootNavigator: true).push(MaterialPageRoute<void>(builder: (_) => DriverInfoPage(tripId: trip.id))),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              _DriverAvatar(tripId: trip.id, photo: parties?.driverPhoto, name: name),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(fontSize: 18, color: c.text)),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Icon(Icons.star_rounded, size: 15, color: c.accent),
                        const SizedBox(width: 3),
                        Flexible(child: Text(rating == null ? l.newDriver : '${rating.toStringAsFixed(1)} (${parties?.driverRatingCount ?? 0})', maxLines: 1, overflow: TextOverflow.ellipsis, style: meta)),
                      ],
                    ),
                  ],
                ),
              ),
              ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, color: c.muted)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The ride and fare cards ("Ride · Economy", "Payment · Cash"; "Trip Fare", "Discounts",
/// "Total").
class TripCards extends ConsumerWidget {
  const TripCards({super.key, required this.trip, this.paid = false});
  final Trip trip;
  /// after the trip: "Total Paid"
  final bool paid;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final cfg = ref.watch(configProvider);
    final f = trip.fare;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        KeyValueCard(rows: [KeyValueCard.row(l.grRide, vehicleName(cfg, trip.vehicleType)), KeyValueCard.row(l.grPayment, paymentMethodLabel(l, trip.paymentMethod))]),
        const SizedBox(height: 12),
        KeyValueCard(
          rows: [
            KeyValueCard.row(l.grTripFare, birr(f.chargedMinor, locale: loc)),
            if ((f.waitingFeeMinor ?? 0) > 0) KeyValueCard.row(l.waitingFeeLabel, birr(f.waitingFeeMinor, locale: loc)),
            if (f.promoDiscountMinor > 0) KeyValueCard.row(f.promoCode == null ? l.grDiscounts : '${l.grDiscounts} (${f.promoCode})', '−${birr(f.promoDiscountMinor, locale: loc)}', valueColor: c.success),
          ],
          total: KeyValueCard.row(paid ? l.grTotalPaid : l.totalLabel, birr(f.payableMinor, locale: loc)),
        ),
      ],
    );
  }
}

/// The driver heading to the pickup, waiting there, and the ride itself.
class _DriverStage extends ConsumerWidget {
  const _DriverStage({required this.trip, required this.stage, required this.parties, required this.live, required this.etaSeconds, required this.pinOn});
  final Trip trip;
  final RiderStage stage;
  final TripParties? parties;
  final DriverLive? live;
  final int? etaSeconds;
  final bool pinOn;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final vehicle = parties?.vehicle;
    final sample = live;
    final eta = etaSeconds;
    final riding = stage == RiderStage.inTrip;
    final arrived = stage == RiderStage.driverArrived;
    final title = riding ? l.grHeadingToDestination : (arrived ? l.grDriverIsHere : l.grDriverHeading);
    final lede = riding
        ? (eta == null ? null : l.grArriveDestinationIn(minutesCeil(eta)))
        : arrived
            ? l.grDriverIsHereLede
            : (eta == null ? null : l.grDriverArrivingIn(minutesCeil(eta)));
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Headline(
          title: title,
          lede: lede,
          extra: riding && eta != null
              ? Text(key: const ValueKey('arrive-at'), l.rideArriveAt(clockHHmm(DateTime.now().add(Duration(seconds: eta)))), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.accentText, fontWeight: FontWeight.w700))
              : null,
        ),
        if (sample != null)
          // stale after 20 s without a position; checked every few seconds, not every frame
          TickingBuilder(
            interval: const Duration(seconds: 5),
            builder: (context, now) {
              final stale = now.toUtc().difference(sample.at) > const Duration(seconds: 20);
              return stale ? Padding(padding: const EdgeInsets.only(top: 4), child: Text(l.positionStale(since(sample.at, now.toUtc())), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.warning, fontWeight: FontWeight.w600))) : const SizedBox.shrink();
            },
          ),
        if (vehicle != null) ...[
          const SizedBox(height: 10),
          Text(key: const ValueKey('vehicle-line'), vehicleLine(vehicle), textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text, fontWeight: FontWeight.w600)),
        ],
        Divider(height: 33, color: c.border),
        _DriverLine(trip: trip, parties: parties),
        Divider(height: 33, color: c.border),
        if (pinOn && trip.pin != null && !riding) ...[
          AppCard(
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(l.grPinTitle, style: AnbessaType.title.copyWith(color: c.text)),
                      const SizedBox(height: 4),
                      Text(l.tellDriverPin, style: AnbessaType.caption.copyWith(color: c.muted)),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                PinDisplay(trip.pin!, size: 36),
              ],
            ),
          ),
          const SizedBox(height: 12),
        ],
        TripCards(trip: trip),
        if (!riding) ...[
          const SizedBox(height: 20),
          CancelRideButton(trip: trip),
        ],
      ],
    );
  }
}

/// The kit's "Driver Information": photo and name, rating · ratings · class, and the car.
class DriverInfoPage extends ConsumerWidget {
  const DriverInfoPage({super.key, required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final parties = ref.watch(tripPartiesProvider(tripId)).value;
    final trip = ref.watch(tripProvider(tripId)).value;
    final cfg = ref.watch(configProvider);
    final name = parties?.driverName ?? l.driverLabel;
    final v = parties?.vehicle;
    final rating = parties?.driverRating;
    final count = parties?.driverRatingCount ?? 0;
    return Scaffold(
      backgroundColor: c.groupedPage,
      appBar: AppTopBar(title: l.grDriverInformation, background: c.groupedPage),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
            child: Column(
              children: [
                AvatarImage(src: parties?.driverPhoto, name: name, size: 104),
                const SizedBox(height: 16),
                Text(name, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text)),
                if (rating == null) ...[const SizedBox(height: 6), Text(l.newDriver, style: AnbessaType.body2.copyWith(color: c.muted))],
              ],
            ),
          ),
          const SizedBox(height: 16),
          StatTriple(
            items: [
              if (rating != null) StatTriple.item(Icons.star_outline_rounded, rating.toStringAsFixed(1), l.grRating),
              if (count > 0) StatTriple.item(Icons.reviews_outlined, '$count', l.grRatings),
              StatTriple.item(Icons.directions_car_outlined, vehicleName(cfg, v?.vehicleType ?? trip?.vehicleType ?? ''), l.grCarClass),
            ],
          ),
          if (v != null) ...[
            const SizedBox(height: 16),
            KeyValueCard(
              rows: [
                KeyValueCard.row(l.grCarModel, [v.make, v.model].where((s) => s.isNotEmpty).join(' ')),
                if (v.color.isNotEmpty) KeyValueCard.row(l.grColor, v.color),
                KeyValueCard.row(l.grPlateNumber, v.plateNumber),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// The end of a trip over the shell: "You have arrived!" over the dimmed map (the kit's result
/// sheet with a red pin), or "Ride has been canceled!" as a page.
class TripEndLayer extends ConsumerWidget {
  const TripEndLayer({super.key, required this.tripId});
  final String tripId;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(tripViewProvider(tripId))?.trip;
    if (t == null) return const SizedBox.shrink();
    return t.status == TripStatus.completed ? _Arrived(trip: t) : _Canceled(trip: t);
  }
}

class _Arrived extends ConsumerWidget {
  const _Arrived({required this.trip});
  final Trip trip;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final t = trip;
    final started = t.times.startedAt, ended = t.times.completedAt;
    final seconds = started != null && ended != null && ended.isAfter(started) ? ended.difference(started).inSeconds : (t.route.durationSeconds ?? t.route.estDurationSeconds);
    final meters = t.route.distanceMeters ?? t.route.estDistanceMeters;
    final kmh = seconds > 0 ? (meters / seconds * 3.6).round() : 0;
    final address = t.dropoff.address ?? l.dropoffLabel;
    final comma = address.indexOf(',');
    final place = comma > 0 ? address.substring(0, comma) : address;
    final rest = comma > 0 ? address.substring(comma + 1).trim() : null;
    return Stack(
      children: [
        Positioned.fill(child: ColoredBox(color: Colors.black.withValues(alpha: 0.45))),
        Align(
          alignment: Alignment.bottomCenter,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height - MediaQuery.paddingOf(context).top - ref.watch(bannerHeightProvider) - 8),
            child: SingleChildScrollView(
              child: ResultSheet(
                title: l.grYouHaveArrived,
                icon: Icons.location_on_rounded,
                danger: true,
                actions: PrimaryButton(
                  key: const ValueKey('finish'),
                  label: l.grFinish,
                  onPressed: () => context.go(t.isDigital ? Routes.riderPay(t.id) : Routes.riderRate(t.id)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Divider(height: 1, color: c.border),
                    const SizedBox(height: 16),
                    Text(place, textAlign: TextAlign.center, style: AnbessaType.h2.copyWith(color: c.text)),
                    if (rest != null && rest.isNotEmpty) ...[const SizedBox(height: 6), Text(rest, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2, fontWeight: FontWeight.w400))],
                    const SizedBox(height: 16),
                    StatTriple(
                      items: [
                        StatTriple.item(Icons.schedule_rounded, l.grMinutes((seconds / 60).round().clamp(1, 999)), l.grDuration),
                        StatTriple.item(Icons.location_on_outlined, km(meters), l.grDistance),
                        StatTriple.item(Icons.speed_rounded, l.grKmh(kmh), l.grAvgSpeed),
                      ],
                    ),
                    const SizedBox(height: 12),
                    TripCards(trip: t, paid: true),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Canceled extends ConsumerWidget {
  const _Canceled({required this.trip});
  final Trip trip;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final cancellation = trip.cancellation;
    final noDriver = cancellation?.reason == 'NO_DRIVER_FOUND';
    final fee = cancellation?.feeMinor ?? 0;
    final message = noDriver
        ? l.noDriverFound
        : fee > 0
            ? '${l.cancelledBy(cancellation?.by.name ?? '')}. ${l.cancelFeeWarning(birr(fee, locale: context.localeTag))}'
            : l.grRideCanceledLede;
    void done() {
      ref.read(activeTripProvider.notifier).clearIfEnded();
      context.go(Routes.riderHome);
    }

    // the banners float over the shell: the page starts under them
    final bannerH = ref.watch(bannerHeightProvider);
    return Material(
      color: c.page,
      child: SafeArea(
        top: bannerH <= 0,
        minimum: EdgeInsets.only(top: bannerH),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Align(alignment: AlignmentDirectional.centerStart, child: Padding(padding: const EdgeInsets.all(8), child: IconButton(tooltip: l.close, icon: Icon(Icons.close_rounded, size: 26, color: c.text), onPressed: done))),
            Expanded(
              child: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: AnbessaSpace.page),
                  child: Column(
                    children: [
                      ResultBadge(icon: noDriver ? Icons.search_off_rounded : Icons.check_rounded),
                      const SizedBox(height: 24),
                      Semantics(header: true, child: Text(noDriver ? l.grNoDriverTitle : l.grRideCanceled, textAlign: TextAlign.center, style: AnbessaType.display.copyWith(color: c.text))),
                      const SizedBox(height: 16),
                      Text(message, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2, fontWeight: FontWeight.w400)),
                    ],
                  ),
                ),
              ),
            ),
            BottomActionBar(child: PrimaryButton(key: const ValueKey('canceled-ok'), label: l.ok, onPressed: done)),
          ],
        ),
      ),
    );
  }
}

/// Share my trip: make (or reuse) the link and hand it to the share sheet; once shared, the same
/// button offers to stop.
class _ShareButton extends ConsumerStatefulWidget {
  const _ShareButton({required this.tripId});
  final String tripId;
  @override
  ConsumerState<_ShareButton> createState() => _ShareButtonState();
}

class _ShareButtonState extends ConsumerState<_ShareButton> {
  TripShare? _share;
  bool _busy = false;

  Future<void> _start() async {
    final l = context.l10n;
    setState(() => _busy = true);
    try {
      final s = await ref.read(apisProvider).trips.share(widget.tripId);
      if (!mounted) return;
      setState(() => _share = s);
      Haptics.light();
      await SharePlus.instance.share(ShareParams(text: l.shareTripText(s.url), subject: l.shareTrip));
    } catch (e) {
      if (mounted) showToast(context, describeError(l, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _menu() async {
    final l = context.l10n;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: SectionGroup(
            margin: EdgeInsets.zero,
            children: [
              SettingsTile(icon: Icons.ios_share_rounded, title: l.shareTrip, onTap: () => Navigator.pop(ctx, 'again')),
              SettingsTile(icon: Icons.link_off_rounded, title: l.stopSharing, destructive: true, onTap: () => Navigator.pop(ctx, 'stop')),
            ],
          ),
        ),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'again') return _start();
    setState(() => _busy = true);
    try {
      await ref.read(apisProvider).trips.stopSharing(widget.tripId);
      if (!mounted) return;
      setState(() => _share = null);
      showToast(context, l.sharingStopped);
    } catch (e) {
      if (mounted) showToast(context, describeError(l, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final on = _share != null;
    return Stack(
      alignment: Alignment.center,
      children: [
        RoundIconButton(icon: on ? Icons.share_location_rounded : Icons.ios_share_rounded, tooltip: on ? l.sharingOn : l.shareTrip, onTap: _busy ? null : (on ? _menu : _start)),
        if (_busy) IgnorePointer(child: SizedBox(width: 40, height: 40, child: CircularProgressIndicator(strokeWidth: 2, color: c.accent))),
      ],
    );
  }
}
