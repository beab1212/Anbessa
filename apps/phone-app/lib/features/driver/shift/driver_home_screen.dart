// The driver's home (workflow 04): the map following their car, health chips, the balance
// banner, a sheet with today's numbers and the car, and one slide to go online or offline. A
// trip offer slides in over it, with its pickup and drop-off drawn on the map.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/config/env.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/push/local_notifications.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../../core/router/routes.dart';
import '../../../core/state.dart';
import '../../maps/anbessa_map.dart';
import '../../shell/shells.dart';
import '../earnings/earnings_controller.dart';
import '../earnings/earnings_summary_controller.dart';
import '../offers/offer_controller.dart';
import '../offers/offer_sheet.dart';
import 'shift_controller.dart';
import 'vehicle_picker_sheet.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});
  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> with SingleTickerProviderStateMixin {
  String? _vehicleId;
  // the driver's own car, glided between fixes; the map draws it every frame and follows it
  late final MarkerAnimator _car = MarkerAnimator(vsync: this);
  // the sheet height goes straight to the map (no rebuild of this screen while it's dragged)
  final _sheetHeight = ValueNotifier<double>(0);
  bool _following = true;
  bool _devOpen = false;

  @override
  void initState() {
    super.initState();
    ref.listenManual(lastPositionProvider, (_, p) {
      if (p != null) _car.push((lat: p.lat, lng: p.lng), heading: p.heading, speed: p.speed, at: p.at);
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    _car.dispose();
    _sheetHeight.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final home = ref.watch(driverHomeProvider);
    final shift = ref.watch(shiftProvider);
    final offer = ref.watch(offerProvider);
    final balance = ref.watch(balanceProvider).value;
    final o = offer.offer;
    // the raw fix only matters while an offer is drawn (the car itself is animated without rebuilds)
    final me = o == null ? null : ref.watch(lastPositionProvider);
    final rt = ref.watch(realtimeStateProvider).value ?? RealtimeState.offline;
    final bannerH = ref.watch(bannerHeightProvider);
    final today = ref.watch(earningsSummaryProvider('today')).value;
    final vehicles = ref.watch(drivableVehiclesProvider).value ?? home.value?.allVehicles ?? const <Vehicle>[];
    final chosenId = _vehicleId ?? ref.read(shiftProvider.notifier).lastVehicleId;
    final chosen = vehicles.where((v) => v.id == chosenId).firstOrNull ?? vehicles.where((v) => v.canDrive ?? true).firstOrNull;
    final top = MediaQuery.paddingOf(context).top + bannerH;
    final balanceBanner = balance != null && balance.state != BalanceState.ok && balance.state != BalanceState.unknown;

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            driverCar: _car,
            follow: _following && o == null ? FollowMode.driver : FollowMode.none,
            followZoom: 15,
            fit: o == null ? const [] : [if (me != null) LatLng(me.lat, me.lng), LatLng(o.pickup.lat, o.pickup.lng), LatLng(o.dropoff.lat, o.dropoff.lng)],
            // fitted once per offer, not on every fix
            fitKey: o?.offerId,
            pickup: o == null ? null : LatLng(o.pickup.lat, o.pickup.lng),
            dropoff: o == null ? null : LatLng(o.dropoff.lat, o.dropoff.lng),
            routes: [
              if (o != null) ...[
                // the way to the pickup dashed, the trip itself solid
                if (me != null) RouteLine([LatLng(me.lat, me.lng), LatLng(o.pickup.lat, o.pickup.lng)], kind: RouteKind.secondary),
                ...() {
                  final r = ref.watch(offerRouteProvider(o)).value;
                  return [if (r != null && r.polyline6.isNotEmpty) RouteLine.fromPolyline6(r.polyline6) else RouteLine(const [], kind: RouteKind.primary)];
                }(),
              ],
            ],
            onUserGesture: () => setState(() => _following = false),
            onRecenter: () => setState(() => _following = true),
            topInset: top + 56,
            sheetHeight: o == null ? _sheetHeight : null,
            bottomInset: o == null ? 0 : 420,
          ),
          // status and health
          Positioned(
            top: top + 8,
            left: 12,
            right: 12,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    MapChip(
                      icon: shift.online ? Icons.wifi_tethering_rounded : Icons.power_settings_new_rounded,
                      label: shift.online ? l.online : l.youAreOffline,
                      tone: shift.online ? c.success : c.muted,
                      pulse: shift.online,
                    ),
                    const SizedBox(width: 8),
                    // health chips wrap onto a second line at large text sizes
                    Expanded(
                      child: Wrap(
                        alignment: WrapAlignment.end,
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          if (balance != null)
                            MapChip(
                              icon: Icons.account_balance_wallet_rounded,
                              label: birr(balance.balanceMinor, locale: context.localeTag),
                              tone: switch (balance.state) { BalanceState.ok || BalanceState.unknown => c.text2, BalanceState.warning => c.warning, _ => c.danger },
                              onTap: () => context.go(Routes.driverTopUp),
                            ),
                          if (shift.online) MapChip(icon: shift.gpsPoor ? Icons.gps_off : Icons.gps_fixed, label: shift.gpsPoor ? l.gpsPoor : l.gpsGood, tone: shift.gpsPoor ? c.danger : c.success),
                          if (shift.online && rt != RealtimeState.connected) MapChip(icon: Icons.wifi_off, label: l.reconnecting, tone: c.warning),
                          if (Env.fakeLocationOn) MapChip(icon: Icons.bug_report_outlined, label: l.devTools, onTap: () => setState(() => _devOpen = !_devOpen)),
                        ],
                      ),
                    ),
                  ],
                ),
                if (balanceBanner)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: FloatingBanner(
                      text: switch (balance.state) {
                        BalanceState.warning => l.balanceWarningLede,
                        BalanceState.cashBlocked => l.balanceCashBlockedLede,
                        BalanceState.blocked => l.balanceBlockedLede,
                        _ => '',
                      },
                      tone: balance.state == BalanceState.warning ? NoticeTone.warning : NoticeTone.error,
                      icon: Icons.account_balance_wallet_outlined,
                      actionLabel: l.topUp,
                      action: () => context.go(Routes.driverTopUp),
                    ),
                  ),
                if (_devOpen && Env.fakeLocationOn) const Padding(padding: EdgeInsets.only(top: 8), child: DevLocationPanel()),
              ],
            ),
          ),
          if (o == null)
            AppSheet(
              snaps: const [0.32, 0.6],
              onHeightChanged: (h) => _sheetHeight.value = h,
              builder: (context, _) => AnimatedSwitcherX(
                child: KeyedSubtree(
                  key: ValueKey(shift.online),
                  child: shift.online ? _online(context, shift, today) : _offline(context, shift, vehicles, chosen, today),
                ),
              ),
            ),
          if (o != null || offer.notice != null) OfferSheet(state: offer),
        ],
      ),
    );
  }

  Widget _stats(BuildContext context, ShiftState shift, EarningsSummary? today) {
    final l = context.l10n;
    final loc = context.localeTag;
    if (today == null) return const SizedBox.shrink();
    final since = shift.session?.startedAt;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: StatRow(
        children: [
          StatTile(label: l.earningsToday, icon: Icons.payments_rounded, value: AnimatedMoney(today.netMinor, locale: loc)),
          StatTile(label: l.tripsToday, icon: Icons.route_rounded, value: AnimatedCounter(value: today.trips, format: (v) => v.round().toString())),
          // ticks on its own, once a minute is enough
          if (since != null) StatTile(label: l.timeOnline, icon: Icons.schedule_rounded, value: TickingBuilder(interval: const Duration(seconds: 30), builder: (_, now) => Text(onlineFor(now.toUtc().difference(since.toUtc()))))),
        ],
      ),
    );
  }

  static String onlineFor(Duration d) {
    if (d.isNegative) d = Duration.zero;
    final h = d.inHours, m = d.inMinutes % 60;
    return h > 0 ? '${h}h ${m}m' : '${m}m';
  }

  Widget _offline(BuildContext context, ShiftState shift, List<Vehicle> vehicles, Vehicle? chosen, EarningsSummary? today) {
    final l = context.l10n;
    final c = context.colors;
    final error = shift.error;
    String? errorText;
    if (error is AppError && error.code == 'location_denied') errorText = l.locationNeededToDrive;
    if (error is AppError && error.code == 'location_off') errorText = l.locationServiceOff;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (shift.endedReason != null && shift.endedReason != 'DRIVER') Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(l.forcedOffline(offlineReasonLabel(l, shift.endedReason)), tone: NoticeTone.warning)),
        _stats(context, shift, today),
        if (vehicles.isEmpty)
          Notice(l.noVehicles, tone: NoticeTone.info, action: TextButton(onPressed: () => context.go(Routes.driverOnboarding), child: Text(l.addVehicle)))
        else ...[
          SectionGroup(
            margin: const EdgeInsets.only(bottom: 12),
            children: [
              SettingsTile(
                icon: chosen == null ? Icons.directions_car_outlined : vehicleIcon(chosen.vehicleType),
                title: chosen == null ? l.chooseVehicle : '${chosen.plateNumber} · ${chosen.label}',
                subtitle: chosen == null ? null : (chosen.canDrive == false ? (chosen.denialMessage != null ? describeError(l, AppError(status: 403, code: chosen.denial ?? '', message: chosen.denialMessage!)) : l.notEligible) : (chosen.isFleet ? l.fleetCar : l.ready)),
                trailing: chosen == null ? null : StatusPill(chosen.canDrive == false ? l.notEligible : l.ready, tone: chosen.canDrive == false ? Tone.red : Tone.green),
                onTap: () async {
                  final v = await showVehiclePicker(context, vehicles: vehicles, selectedId: chosen?.id);
                  if (v != null) setState(() => _vehicleId = v.id);
                },
              ),
            ],
          ),
          if (errorText != null)
            Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(errorText, tone: NoticeTone.error, action: TextButton(onPressed: () => ref.read(locationSourceProvider).openSettings(), child: Text(l.openSettings))))
          else if (error != null)
            Padding(padding: const EdgeInsets.only(bottom: 10), child: Problem(error, describe: (e) => describeError(l, e))),
          SwipeToConfirm(
            label: l.slideToGoOnline,
            icon: Icons.power_settings_new_rounded,
            tone: Tone.amber,
            busy: shift.busy,
            enabled: chosen != null && chosen.canDrive != false,
            onConfirmed: () async {
              await ref.read(localNotificationsProvider).requestPermission();
              await ref.read(shiftProvider.notifier).goOnline(chosen!);
            },
          ),
        ],
        if (Env.fakeLocationOn) Padding(padding: const EdgeInsets.only(top: 8), child: Text('${l.devTools}: ${l.youAreHere} ${ref.watch(lastPositionProvider)?.let((p) => '${p.lat.toStringAsFixed(4)}, ${p.lng.toStringAsFixed(4)}') ?? '—'}', style: AnbessaType.caption.copyWith(color: c.faint))),
      ],
    );
  }

  Widget _online(BuildContext context, ShiftState shift, EarningsSummary? today) {
    final l = context.l10n;
    final c = context.colors;
    final v = shift.vehicle;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Container(width: 44, height: 44, decoration: BoxDecoration(color: c.successSoft, shape: BoxShape.circle), child: const RadarPulse(color: Color(0xFF22C55E), size: 44, rings: 2)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l.waitingForOffers, style: AnbessaType.title.copyWith(color: c.text)),
                  Text(v == null ? l.online : '${v.plateNumber} · ${v.label}', style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        _stats(context, shift, today),
        Problem(shift.error, describe: (e) => describeError(l, e)),
        SwipeToConfirm(label: l.slideToGoOffline, icon: Icons.power_settings_new, tone: Tone.grey, busy: shift.busy, onConfirmed: () => ref.read(shiftProvider.notifier).goOffline()),
      ],
    );
  }
}

/// Development only (Linux, FAKE_LOCATION=on): steer the fake position. "Drive to target" moves
/// at 40 km/h towards the active trip's pickup, then drop-off.
class DevLocationPanel extends ConsumerWidget {
  const DevLocationPanel({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final src = ref.watch(locationSourceProvider);
    if (src is! FakeLocationSource) return const SizedBox.shrink();
    final c = context.colors;
    final pos = ref.watch(lastPositionProvider);
    return FloatingCard(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      radius: AnbessaRadius.md,
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 4,
        children: [
          Text('fake GPS ${pos == null ? '' : '${pos.lat.toStringAsFixed(4)}, ${pos.lng.toStringAsFixed(4)}'}', style: TextStyle(fontSize: 11, color: c.text2, fontFamilyFallback: monoFamilyFallback)),
          TextButton(onPressed: () => src.set(8.9806, 38.7578), child: const Text('Bole')),
          TextButton(onPressed: () => src.set(9.0107, 38.7613), child: const Text('Meskel')),
          TextButton(onPressed: () => src.set(9.0349, 38.7469), child: const Text('Piassa')),
          const DevDriveButton(),
        ],
      ),
    );
  }
}

class DevDriveButton extends ConsumerWidget {
  const DevDriveButton({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final src = ref.watch(locationSourceProvider);
    if (src is! FakeLocationSource) return const SizedBox.shrink();
    return TextButton(
      onPressed: () {
        final t = ref.read(devDriveTargetProvider);
        if (t != null) src.driveTo(t.$1, t.$2);
      },
      child: const Text('Drive to target'),
    );
  }
}

/// Where the dev "drive" button goes: the active trip's pickup, then drop-off (set by the trip screen).
final devDriveTargetProvider = valueProvider<(double, double)?>(null);
