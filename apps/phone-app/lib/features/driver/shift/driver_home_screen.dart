// The driver's home (workflow 04): offline → pick a car and go online; online → the map with
// their own position, ping health, and the offer sheet when a trip comes in. A balance banner
// says when cash trips are paused or driving is blocked.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/config/env.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/push/local_notifications.dart';
import '../../../core/router/routes.dart';
import '../../../core/state.dart';
import '../../maps/anbessa_map.dart';
import '../earnings/earnings_controller.dart';
import '../offers/offer_controller.dart';
import '../offers/offer_sheet.dart';
import 'shift_controller.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});
  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> {
  String? _vehicleId;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final home = ref.watch(driverHomeProvider);
    final shift = ref.watch(shiftProvider);
    final offer = ref.watch(offerProvider);
    final balance = ref.watch(balanceProvider).value;
    final me = ref.watch(lastPositionProvider);
    final vehicles = ref.watch(drivableVehiclesProvider).value ?? home.value?.allVehicles ?? const <Vehicle>[];
    final chosenId = _vehicleId ?? ref.read(shiftProvider.notifier).lastVehicleId;
    final chosen = vehicles.where((v) => v.id == chosenId).firstOrNull ?? vehicles.where((v) => v.canDrive ?? true).firstOrNull;

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            center: me == null ? null : LatLng(me.lat, me.lng),
            zoom: 15,
            driver: me == null ? null : DriverMarkerData(position: LatLng(me.lat, me.lng), heading: me.heading, stale: false, onTrip: false),
          ),
          SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: Row(
                    children: [
                      StatusPill(shift.online ? l.online : l.youAreOffline, tone: shift.online ? Tone.green : Tone.grey, pulse: shift.online),
                      const Spacer(),
                      if (shift.online)
                        Text(shift.gpsPoor ? l.gpsPoor : l.pingsOk, style: TextStyle(color: shift.gpsPoor ? c.danger : c.success, fontSize: 12, fontWeight: FontWeight.w600, shadows: const [Shadow(color: Colors.white, blurRadius: 8)])),
                    ],
                  ),
                ),
                if (Env.fakeLocationOn) const Padding(padding: EdgeInsets.fromLTRB(16, 8, 16, 0), child: DevLocationPanel()),
                const Spacer(),
                if (balance != null && balance.state != BalanceState.ok && balance.state != BalanceState.unknown)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: Notice(
                      switch (balance.state) {
                        BalanceState.warning => l.balanceWarningLede,
                        BalanceState.cashBlocked => l.balanceCashBlockedLede,
                        BalanceState.blocked => l.balanceBlockedLede,
                        _ => '',
                      },
                      tone: balance.state == BalanceState.warning ? NoticeTone.warning : NoticeTone.error,
                      action: TextButton(onPressed: () => context.go(Routes.driverEarnings), child: Text(l.topUp)),
                    ),
                  ),
                Card(
                  margin: const EdgeInsets.all(16),
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: shift.online ? _online(context, shift, home.value) : _offline(context, shift, vehicles, chosen),
                  ),
                ),
              ],
            ),
          ),
          if (offer.offer != null || offer.notice != null) OfferSheet(state: offer),
        ],
      ),
    );
  }

  Widget _offline(BuildContext context, ShiftState shift, List<Vehicle> vehicles, Vehicle? chosen) {
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
        if (vehicles.isEmpty)
          Notice(l.noVehicles, tone: NoticeTone.info, action: TextButton(onPressed: () => context.go(Routes.driverOnboarding), child: Text(l.addVehicle)))
        else ...[
          DropdownButtonFormField<String>(
            initialValue: chosen?.id,
            decoration: InputDecoration(labelText: l.chooseVehicle),
            items: [
              for (final v in vehicles)
                DropdownMenuItem(value: v.id, enabled: v.canDrive ?? true, child: Text('${v.plateNumber} · ${v.label}${v.isFleet ? ' · ${l.fleetCar}' : ''}', overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() => _vehicleId = v),
          ),
          if (chosen != null && chosen.canDrive == false && chosen.denialMessage != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(describeError(l, AppError(status: 403, code: chosen.denial ?? '', message: chosen.denialMessage!)), style: TextStyle(color: c.danger, fontSize: 13))),
          const SizedBox(height: 12),
          if (errorText != null)
            Notice(errorText, tone: NoticeTone.error, action: TextButton(onPressed: () => ref.read(locationSourceProvider).openSettings(), child: Text(l.openSettings)))
          else
            Problem(error, describe: (e) => describeError(l, e)),
          if (error != null) const SizedBox(height: 10),
          PrimaryButton(
            label: shift.busy ? l.goingOnline : l.goOnline,
            icon: Icons.power_settings_new,
            busy: shift.busy,
            onPressed: chosen == null || chosen.canDrive == false
                ? null
                : () async {
                    await ref.read(localNotificationsProvider).requestPermission();
                    await ref.read(shiftProvider.notifier).goOnline(chosen);
                  },
          ),
        ],
      ],
    );
  }

  Widget _online(BuildContext context, ShiftState shift, DriverHome? home) {
    final l = context.l10n;
    final c = context.colors;
    final v = shift.vehicle;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            Icon(Icons.directions_car, color: c.accentStrong),
            const SizedBox(width: 10),
            Expanded(child: Text(v == null ? l.online : '${v.plateNumber} · ${v.label}', style: const TextStyle(fontWeight: FontWeight.w600))),
            if (shift.session != null) Text(l.onlineSince(clockOf(shift.session!.startedAt)), style: TextStyle(color: c.muted, fontSize: 12)),
          ],
        ),
        const SizedBox(height: 8),
        Text(l.waitingForOffers, style: TextStyle(color: c.text2)),
        const SizedBox(height: 12),
        Problem(shift.error, describe: (e) => describeError(l, e)),
        OutlinedButton.icon(onPressed: shift.busy ? null : () => ref.read(shiftProvider.notifier).goOffline(), icon: const Icon(Icons.power_settings_new), label: Text(l.goOffline)),
      ],
    );
  }
}

/// Development only (Linux, FAKE_LOCATION=on): steer the fake position. Tap the map to teleport;
/// "Drive to pickup" moves at 40 km/h towards the active trip's pickup, then drop-off.
class DevLocationPanel extends ConsumerWidget {
  const DevLocationPanel({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final src = ref.watch(locationSourceProvider);
    if (src is! FakeLocationSource) return const SizedBox.shrink();
    final c = context.colors;
    final pos = ref.watch(lastPositionProvider);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(color: c.warningSoft, borderRadius: BorderRadius.circular(anbessaRadius), border: Border.all(color: c.accent)),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        children: [
          Text('fake GPS ${pos == null ? '' : '${pos.lat.toStringAsFixed(4)}, ${pos.lng.toStringAsFixed(4)}'}', style: TextStyle(fontSize: 11, color: c.accentStrong, fontFamilyFallback: monoFamilyFallback)),
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
