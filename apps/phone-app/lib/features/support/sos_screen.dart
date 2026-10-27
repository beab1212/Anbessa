// SOS (workflow 14): call the police at once, or hold for two seconds to alert Anbessa's safety
// team with the trip and the position. After sending, the alert's state is polled every 5 s until
// it is resolved, and a newer position is sent while it is live. Works for the rider and the
// driver on an active trip and for 30 minutes after drop-off (support-service refuses otherwise).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../core/l10n/l10n.dart';
import '../../core/location/location_source.dart';
import '../../core/network/providers.dart';
import '../../core/state.dart';
import '../profile/settings_controllers.dart';
import '../rider/trip/active_trip_controller.dart';
import 'support_repository.dart';

/// The police number in Ethiopia.
const policeNumber = '991';

/// The alert sent for each trip during this app run, so reopening the screen shows its state
/// instead of the hold button.
final sosAlertsProvider = valueProvider<Map<String, SosAlert>>(const {});

/// How often the alert's state is polled while it is live.
const sosPollEvery = Duration(seconds: 5);

enum _Phase { idle, sending, sent, failed }

class SosScreen extends ConsumerStatefulWidget {
  const SosScreen({super.key, this.tripId});
  final String? tripId;
  @override
  ConsumerState<SosScreen> createState() => _SosScreenState();
}

class _SosScreenState extends ConsumerState<SosScreen> {
  // one key for this screen: a retry after a network failure is the same request
  final String _key = newIdempotencyKey();
  _Phase _phase = _Phase.idle;
  SosAlert? _alert;
  bool _duplicate = false;
  Object? _error;
  bool _pollFailed = false;
  bool _approximate = false;
  Timer? _poll;
  DevicePosition? _sentPosition;

  String? get _tripId => widget.tripId ?? ref.read(activeTripProvider).value?.id;

  @override
  void initState() {
    super.initState();
    final id = _tripId;
    final known = id == null ? null : ref.read(sosAlertsProvider)[id];
    if (known != null) {
      _alert = known;
      _phase = _Phase.sent;
      if (known.isLive) _startPolling();
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  /// The freshest position we can get quickly: a recent one, else one fix (8 s at most), else any
  /// last one, else the trip's own point with a wide accuracy so the team still knows the area.
  Future<({double lat, double lng, double? accuracy, bool approximate})?> _position(Trip? trip) async {
    final last = ref.read(lastPositionProvider);
    if (last != null && DateTime.now().difference(last.at) < const Duration(minutes: 2)) return (lat: last.lat, lng: last.lng, accuracy: last.accuracy, approximate: false);
    try {
      final source = ref.read(locationSourceProvider);
      final fix = await () async {
        if (await source.ensurePermission(LocationProfile.once) != LocationPermissionState.granted) return null;
        return source.current();
      }()
          .timeout(const Duration(seconds: 8));
      if (fix != null) {
        ref.read(lastPositionProvider.notifier).set(fix);
        return (lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, approximate: false);
      }
    } catch (_) {}
    if (last != null) return (lat: last.lat, lng: last.lng, accuracy: last.accuracy, approximate: false);
    if (trip == null) return null;
    final p = trip.status == TripStatus.completed || trip.status == TripStatus.inProgress ? trip.dropoff : trip.pickup;
    return (lat: p.lat, lng: p.lng, accuracy: 2000.0, approximate: true);
  }

  Future<void> _send(Trip? trip) async {
    final tripId = _tripId;
    if (tripId == null || _phase == _Phase.sending) return;
    setState(() {
      _phase = _Phase.sending;
      _error = null;
    });
    try {
      final pos = await _position(trip);
      if (pos == null) throw const AppError(status: 0, code: ErrorCodes.positionUnknown, message: 'position unknown');
      final r = await ref.read(safetyRepositoryProvider).raiseSos(tripId: tripId, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, cityId: trip?.cityId, idempotencyKey: _key);
      _sentPosition = ref.read(lastPositionProvider);
      _approximate = pos.approximate;
      _remember(r.alert);
      Haptics.heavy();
      if (!mounted) return;
      setState(() {
        _alert = r.alert;
        _duplicate = r.duplicate;
        _phase = _Phase.sent;
      });
      if (r.alert.isLive) _startPolling();
    } catch (e) {
      Haptics.error();
      if (mounted) {
        setState(() {
          _error = e;
          _phase = _Phase.failed;
        });
      }
    }
  }

  void _remember(SosAlert a) {
    final n = ref.read(sosAlertsProvider.notifier);
    n.set({...ref.read(sosAlertsProvider), a.tripId.isEmpty ? _tripId! : a.tripId: a});
  }

  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(sosPollEvery, (_) => _tick());
  }

  Future<void> _tick() async {
    final alert = _alert;
    if (alert == null) return;
    final repo = ref.read(safetyRepositoryProvider);
    try {
      final next = await repo.sosStatus(alert.id);
      _remember(next);
      if (!mounted) return;
      setState(() {
        _alert = next;
        _pollFailed = false;
      });
      if (!next.isLive) {
        _poll?.cancel();
        return;
      }
      // a newer position (the driver's pings, or a fix the rider's screens took) goes along
      final now = ref.read(lastPositionProvider);
      final sent = _sentPosition;
      if (now != null && (sent == null || (now.at.isAfter(sent.at) && metersBetween(sent, now.lat, now.lng) > 30))) {
        _sentPosition = now;
        unawaited(repo.updateSosLocation(alert.id, lat: now.lat, lng: now.lng, accuracy: now.accuracy).catchError((_) {}));
      }
    } catch (_) {
      if (mounted) setState(() => _pollFailed = true);
    }
  }

  void _call(String number) {
    Haptics.heavy();
    launchUrl(Uri.parse('tel:$number'));
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final tripId = _tripId;
    final trip = tripId == null ? null : ref.watch(tripProvider(tripId)).value;
    // unknown trip state (offline): let the server decide
    final open = tripId != null && (trip == null || sosAvailable(trip, DateTime.now()));
    final contact = ref.watch(emergencyContactProvider);
    final alert = _alert;

    return Scaffold(
      appBar: AppBar(title: Text(l.sosTitle)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          if (alert != null && _phase == _Phase.sent) ...[
            _AlertStatus(alert: alert, duplicate: _duplicate, approximate: _approximate, pollFailed: _pollFailed),
            const SizedBox(height: 24),
          ] else ...[
            Text(l.sosLede, style: AnbessaType.body.copyWith(color: c.text2)),
            const SizedBox(height: 24),
          ],
          PrimaryButton(label: l.callPolice, icon: Icons.phone, danger: true, onPressed: () => _call(policeNumber)),
          const SizedBox(height: 12),
          if (alert == null || _phase != _Phase.sent) ...[
            if (_phase == _Phase.sending)
              _Sending(label: l.sosSending)
            else
              HoldToConfirm(
                label: l.alertSafety,
                hint: l.sosHoldHint,
                enabled: open,
                onConfirmed: () => _send(trip),
              ),
            const SizedBox(height: 8),
            Text(open ? l.sosHoldLede : (tripId == null ? l.sosNoTrip : l.sosWindowClosed), style: AnbessaType.caption.copyWith(color: c.muted)),
            if (_phase == _Phase.failed) ...[
              const SizedBox(height: 16),
              Notice(l.sosFailed, tone: NoticeTone.error),
              const SizedBox(height: 8),
              Problem(_error, describe: (e) => describeError(l, e)),
              const SizedBox(height: 8),
              OutlinedButton(onPressed: () => _send(trip), child: Text(l.sosSendAgain)),
            ],
          ],
          if (contact != null) ...[
            const SizedBox(height: 24),
            SectionGroup(
              margin: EdgeInsets.zero,
              children: [SettingsTile(icon: Icons.phone_outlined, title: l.sosCallContact(contact.name), subtitle: formatPhone(contact.phone), chevron: false, onTap: () => _call(contact.phone))],
            ),
          ],
        ],
      ),
    );
  }
}

class _AlertStatus extends StatelessWidget {
  const _AlertStatus({required this.alert, required this.duplicate, required this.approximate, required this.pollFailed});
  final SosAlert alert;
  final bool duplicate;
  final bool approximate;
  final bool pollFailed;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final (pill, tone, title, body) = switch (alert.status) {
      SosStatus.acknowledged => (l.sosStatusAcknowledged, Tone.amber, l.sosAcknowledgedTitle, l.sosAcknowledgedBody),
      SosStatus.resolved => (l.sosStatusResolved, Tone.green, l.sosResolvedTitle, _outcome(l, alert.outcome)),
      _ => (l.sosStatusOpen, Tone.red, l.sosOpenTitle, l.sosOpenBody),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Align(alignment: Alignment.centerLeft, child: StatusPill(pill, tone: tone, pulse: alert.isLive)),
        const SizedBox(height: 12),
        Text(title, style: AnbessaType.h2.copyWith(color: c.text)),
        const SizedBox(height: 8),
        Text(body, style: AnbessaType.body.copyWith(color: c.text2)),
        const SizedBox(height: 12),
        KeyValue(l.sosSentAt, Text(dayAndTime(alert.triggeredAt, locale: context.localeTag))),
        if (alert.acknowledgedAt != null) KeyValue(l.sosSeenAt, Text(dayAndTime(alert.acknowledgedAt!, locale: context.localeTag))),
        if (duplicate) ...[const SizedBox(height: 8), Notice(l.sosDuplicate)],
        if (approximate) ...[const SizedBox(height: 8), Notice(l.sosApproximate, tone: NoticeTone.warning)],
        if (pollFailed) ...[const SizedBox(height: 8), Text(l.sosStatusStale, style: AnbessaType.caption.copyWith(color: c.muted))],
      ],
    );
  }

  static String _outcome(AppLocalizations l, SosOutcome? o) => switch (o) {
        SosOutcome.falseAlarm => l.sosOutcomeFalseAlarm,
        SosOutcome.assisted => l.sosOutcomeAssisted,
        SosOutcome.escalated => l.sosOutcomeEscalated,
        _ => l.sosResolvedBody,
      };
}

class _Sending extends StatelessWidget {
  const _Sending({required this.label});
  final String label;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      height: 64,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(color: c.dangerSoft, borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: c.danger, width: 2)),
      child: Row(
        children: [
          SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: c.danger)),
          const SizedBox(width: 12),
          Expanded(child: Text(label, style: AnbessaType.title.copyWith(color: c.danger))),
        ],
      ),
    );
  }
}

/// A button that fires only after being held for [duration]; the fill shows how far along the
/// hold is and drains if the finger lifts early. Screen readers trigger it with a long press.
class HoldToConfirm extends StatefulWidget {
  const HoldToConfirm({super.key, required this.label, required this.onConfirmed, this.hint, this.enabled = true, this.duration = const Duration(seconds: 2)});
  final String label;
  final String? hint;
  final VoidCallback onConfirmed;
  final bool enabled;
  final Duration duration;
  @override
  State<HoldToConfirm> createState() => _HoldToConfirmState();
}

class _HoldToConfirmState extends State<HoldToConfirm> with SingleTickerProviderStateMixin {
  late final AnimationController _hold = AnimationController(vsync: this, duration: widget.duration)
    ..addStatusListener((s) {
      if (s == AnimationStatus.completed) {
        widget.onConfirmed();
        _hold.value = 0;
      }
    });

  @override
  void dispose() {
    _hold.dispose();
    super.dispose();
  }

  void _down(PointerDownEvent _) {
    if (!widget.enabled) return;
    Haptics.medium();
    _hold.forward();
  }

  void _up(PointerEvent _) {
    if (_hold.isAnimating && _hold.status == AnimationStatus.forward) _hold.animateBack(0, duration: const Duration(milliseconds: 200));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final on = widget.enabled;
    final fg = on ? c.danger : c.faint;
    Widget face(Color text, Color fill) => Container(
          height: 64,
          alignment: Alignment.center,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          color: fill,
          child: Text(widget.label, textAlign: TextAlign.center, maxLines: 2, style: AnbessaType.title.copyWith(color: text)),
        );
    return Semantics(
      button: true,
      enabled: on,
      label: widget.label,
      hint: widget.hint,
      onLongPress: on ? widget.onConfirmed : null,
      excludeSemantics: true,
      child: Listener(
        onPointerDown: _down,
        onPointerUp: _up,
        onPointerCancel: _up,
        child: Container(
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.md), border: Border.all(color: fg, width: 2)),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(AnbessaRadius.md - 2),
            child: LayoutBuilder(
              builder: (context, box) => AnimatedBuilder(
                animation: _hold,
                builder: (context, _) => Stack(
                  children: [
                    face(fg, on ? c.dangerSoft : c.surface2),
                    // the filled part, with the label in white over it
                    ClipRect(
                      child: Align(
                        alignment: Alignment.centerLeft,
                        widthFactor: _hold.value,
                        child: SizedBox(width: box.maxWidth, child: face(Colors.white, c.danger)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
