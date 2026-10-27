// Choosing the ride (workflow 05 B–C): the route on the map, one card per vehicle type with its
// ETA and fixed price, the fare breakdown, the payment method, and Request. Quotes last 10
// minutes; a new price is fetched when one expires.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../trip/active_trip_controller.dart';
import 'booking_controller.dart';

class QuoteScreen extends ConsumerStatefulWidget {
  const QuoteScreen({super.key});
  @override
  ConsumerState<QuoteScreen> createState() => _QuoteScreenState();
}

class _QuoteScreenState extends ConsumerState<QuoteScreen> {
  Timer? _tick;
  DateTime _now = DateTime.now().toUtc();
  bool _requesting = false;
  Object? _error;
  double _sheetHeight = 0;
  bool _breakdownOpen = false;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now().toUtc()));
    final b = ref.read(bookingProvider);
    if (b.ready && b.quotes.isEmpty && !b.quoting) ref.read(bookingProvider.notifier).quote();
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _request() async {
    Haptics.heavy();
    setState(() {
      _requesting = true;
      _error = null;
    });
    try {
      final trip = await ref.read(bookingProvider.notifier).request();
      Haptics.success();
      if (mounted) context.go(Routes.riderTrip(trip.id));
    } on AppError catch (e) {
      if (e.code == ErrorCodes.activeTripExists) {
        await ref.read(activeTripProvider.notifier).refresh();
        final t = ref.read(activeTripProvider).value;
        if (t != null && mounted) context.go(Routes.riderTrip(t.id));
        return;
      }
      if (e.code == ErrorCodes.quoteExpired || e.code == ErrorCodes.invalidQuote) ref.read(bookingProvider.notifier).quote();
      Haptics.error();
      setState(() => _error = e);
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
  }

  Future<void> _choosePayment(List<PaymentMethod> offered, Session? session) async {
    final l = context.l10n;
    final c = context.colors;
    final b = ref.read(bookingProvider);
    final picked = await showModalBottomSheet<PaymentMethod>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 8), child: Align(alignment: Alignment.centerLeft, child: Text(l.paymentMethod, style: AnbessaType.h2.copyWith(color: c.text)))),
            for (final m in offered)
              ChoiceRow(
                title: paymentMethodLabel(l, m),
                leading: Icon(_methodIcon(m), color: c.accentStrong),
                selected: b.paymentMethod == m,
                onTap: () => Navigator.pop(ctx, m),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (picked != null) ref.read(bookingProvider.notifier).pay(picked, billingOrgId: picked == PaymentMethod.corporate ? session?.claims.orgIds.firstOrNull : null);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final b = ref.watch(bookingProvider);
    final cfg = ref.watch(configProvider);
    final methods = ref.watch(paymentMethodsProvider).value ?? PaymentMethodsConfig.fallback;
    final session = ref.watch(currentSessionProvider);
    final corporateOk = ref.watch(featureProvider(Feature.corporateBooking)) && (session?.claims.orgIds.isNotEmpty ?? false);
    final promos = ref.watch(featureProvider(Feature.promos));
    final paused = cfg.maintenance.newTripsPaused;
    final quote = b.quote;
    final expired = quote != null && quote.isExpired(_now);
    String nameOf(String code) => cfg.vehicleTypes.where((v) => v.code == code).firstOrNull?.name ?? code;
    final offered = [...methods.methods.where((m) => m != PaymentMethod.corporate), if (corporateOk) PaymentMethod.corporate];
    if (!offered.contains(b.paymentMethod) && offered.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(bookingProvider.notifier).pay(offered.first));
    }
    final pickup = b.pickup == null ? null : LatLng(b.pickup!.lat, b.pickup!.lng);
    final dropoff = b.dropoff == null ? null : LatLng(b.dropoff!.lat, b.dropoff!.lng);
    final route = b.route?.polyline6.isNotEmpty == true ? RouteLine.fromPolyline6(b.route!.polyline6) : (pickup != null && dropoff != null ? RouteLine.straight(pickup, dropoff) : null);
    final summary = b.route ?? (quote == null ? null : QuoteRoute(polyline6: '', distanceMeters: quote.distanceMeters, durationSeconds: quote.durationSeconds, approximate: quote.approximate));
    final top = MediaQuery.paddingOf(context).top;

    return Scaffold(
      body: Stack(
        children: [
          AnbessaMap(
            fit: [?pickup, ?dropoff],
            pickup: pickup,
            dropoff: dropoff,
            routes: [?route],
            topInset: top + 56,
            bottomInset: _sheetHeight,
            showControls: false,
            callouts: [
              if (pickup != null) MapCallout(point: pickup, label: b.pickup!.name, icon: Icons.trip_origin, offsetY: -52),
              if (dropoff != null) MapCallout(point: dropoff, label: b.dropoff!.name, icon: Icons.stop_rounded, offsetY: -52),
            ],
          ),
          Positioned(top: top + 8, left: 12, child: MapControlButton(icon: Icons.arrow_back, tooltip: l.back, onTap: () => context.pop())),
          AppSheet(
            snaps: const [0.48, 0.92],
            onHeightChanged: (h) {
              if ((h - _sheetHeight).abs() > 2) setState(() => _sheetHeight = h);
            },
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            header: _RouteSummary(b: b, summary: summary, onEdit: () => context.pushReplacement(Routes.riderRoute)),
            footer: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (paused) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(cfg.maintenance.message.isEmpty ? l.newTripsPaused : cfg.maintenance.message, tone: NoticeTone.warning)),
                Problem(_error, describe: (e) => describeError(l, e)),
                if (_error != null) const SizedBox(height: 10),
                if (b.quotes.isEmpty && !b.quoting)
                  const SizedBox.shrink()
                else if (expired)
                  PrimaryButton(label: l.getNewQuote, icon: Icons.refresh, onPressed: () => ref.read(bookingProvider.notifier).quote())
                else
                  PrimaryButton(
                    label: l.requestRide(nameOf(quote?.vehicleType ?? '')),
                    trailing: quote == null ? null : birr(quote.fareMinor, locale: context.localeTag),
                    busy: _requesting || b.quoting,
                    onPressed: paused || quote == null ? null : _request,
                  ),
              ],
            ),
            builder: (context, _) => Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (b.quoting && b.quotes.isEmpty) ...[const SkeletonCard(height: 84), const SizedBox(height: 10), const SkeletonCard(height: 84), const SizedBox(height: 10), const SkeletonCard(height: 84)],
                if (b.quoteError != null) Problem(b.quoteError, describe: (e) => describeError(l, e), onRetry: () => ref.read(bookingProvider.notifier).quote(), retryLabel: l.retry),
                if (b.quotes.isNotEmpty) ...[
                  if (quote?.approximate ?? false) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(l.estimateApproximate, tone: NoticeTone.info)),
                  for (final (i, q) in b.quotes.indexed)
                    FadeSlideIn(
                      delay: Duration(milliseconds: 50 * i),
                      child: _QuoteCard(
                        name: nameOf(q.vehicleType),
                        seats: cfg.vehicleTypes.where((v) => v.code == q.vehicleType).firstOrNull?.seatsMax,
                        quote: q,
                        selected: q.vehicleType == b.vehicleType,
                        expired: expired,
                        onTap: () {
                          Haptics.selection();
                          ref.read(bookingProvider.notifier).choose(q.vehicleType);
                        },
                      ),
                    ),
                  if (quote?.breakdown != null) ...[
                    const SizedBox(height: 4),
                    InkWell(
                      borderRadius: BorderRadius.circular(AnbessaRadius.md),
                      onTap: () => setState(() => _breakdownOpen = !_breakdownOpen),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
                        child: Row(
                          children: [
                            Text(l.fareBreakdown, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w600, color: c.text)),
                            const Spacer(),
                            AnimatedRotation(turns: _breakdownOpen ? 0.5 : 0, duration: AnbessaMotion.of(context, AnbessaMotion.base), child: Icon(Icons.expand_more, color: c.muted)),
                          ],
                        ),
                      ),
                    ),
                    AnimatedSwitcherX(
                      child: _breakdownOpen
                          ? Padding(
                              key: const ValueKey('bd'),
                              padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
                              child: Column(
                                children: [
                                  _BdRow(l.baseFare, quote!.breakdown!.baseMinor),
                                  _BdRow(l.distanceFare, quote.breakdown!.distanceMinor),
                                  _BdRow(l.timeFare, quote.breakdown!.timeMinor),
                                  if (quote.breakdown!.minimumApplied) Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.minimumFareApplied, style: AnbessaType.caption.copyWith(color: c.muted))),
                                ],
                              ),
                            )
                          : const SizedBox.shrink(key: ValueKey('nobd')),
                    ),
                  ],
                  const SizedBox(height: 4),
                  SectionGroup(
                    margin: EdgeInsets.zero,
                    children: [
                      SettingsValueTile(icon: _methodIcon(b.paymentMethod), title: l.paymentMethod, value: paymentMethodLabel(l, b.paymentMethod), onTap: offered.length > 1 ? () => _choosePayment(offered, session) : null),
                      if (promos) SettingsTile(icon: Icons.local_offer_outlined, title: l.promoCode, badge: StatusPill(l.comingSoon, tone: Tone.grey), onTap: () => context.push(Routes.promosRedeem)),
                    ],
                  ),
                  const SizedBox(height: 10),
                  if (quote != null)
                    Row(
                      children: [
                        Icon(Icons.timer_outlined, size: 14, color: expired ? c.danger : c.muted),
                        const SizedBox(width: 4),
                        Text(expired ? l.quoteExpired : l.quoteExpiresIn(mmss(quote.expiresAt.difference(_now))), style: AnbessaType.caption.copyWith(color: expired ? c.danger : c.muted, fontFeatures: AnbessaType.tabular)),
                      ],
                    ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

IconData _methodIcon(PaymentMethod m) => switch (m) {
      PaymentMethod.cash => Icons.payments_outlined,
      PaymentMethod.mobileMoney => Icons.phone_iphone,
      PaymentMethod.card => Icons.credit_card,
      PaymentMethod.corporate => Icons.business_center_outlined,
      _ => Icons.payment,
    };

class _RouteSummary extends StatelessWidget {
  const _RouteSummary({required this.b, required this.summary, required this.onEdit});
  final Booking b;
  final QuoteRoute? summary;
  final VoidCallback onEdit;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Column(
            children: [
              Icon(Icons.trip_origin, size: 12, color: c.accent),
              Container(width: 2, height: 14, color: c.border),
              Icon(Icons.stop_rounded, size: 14, color: c.text),
            ],
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(b.pickup?.name ?? '—', maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.text2)),
                const SizedBox(height: 6),
                Text(b.dropoff?.name ?? '—', maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w600, color: c.text)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (summary != null) Text(l.distanceTime(km(summary!.distanceMeters), minutesOf(summary!.durationSeconds)), style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)),
              TextButton(onPressed: onEdit, style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: EdgeInsets.zero), child: Text(l.edit)),
            ],
          ),
        ],
      ),
    );
  }
}

class _BdRow extends StatelessWidget {
  const _BdRow(this.label, this.minor);
  final String label;
  final int minor;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(child: Text(label, style: AnbessaType.body2.copyWith(color: c.text2))),
          MoneyText(minor, locale: context.localeTag, style: AnbessaType.body2.copyWith(color: c.text)),
        ],
      ),
    );
  }
}

class _QuoteCard extends StatelessWidget {
  const _QuoteCard({required this.name, required this.quote, required this.selected, required this.onTap, this.seats, this.expired = false});
  final String name;
  final int? seats;
  final Quote quote;
  final bool selected;
  final bool expired;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AnimatedScale(
        scale: selected ? 1.02 : 1,
        duration: AnbessaMotion.of(context, AnbessaMotion.base),
        curve: AnbessaMotion.spring,
        child: Material(
          color: selected ? c.accentSoft : c.surface,
          borderRadius: BorderRadius.circular(AnbessaRadius.lg),
          child: InkWell(
            borderRadius: BorderRadius.circular(AnbessaRadius.lg),
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: Border.all(color: selected ? c.accent : c.border, width: selected ? 2 : 1)),
              child: Row(
                children: [
                  VehicleGlyph(quote.vehicleType, selected: selected, size: 48),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Flexible(child: Text(name, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis)),
                            if (seats != null) ...[const SizedBox(width: 6), Icon(Icons.person_outline, size: 14, color: c.muted), Text('$seats', style: AnbessaType.caption.copyWith(color: c.muted))],
                          ],
                        ),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            EtaBadge(seconds: quote.etaToPickupSeconds, minuteLabel: (m) => l.etaMinutes(m), icon: Icons.schedule),
                            const SizedBox(width: 6),
                            Flexible(child: Text(l.distanceTime(km(quote.distanceMeters), minutesOf(quote.durationSeconds)), style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis)),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      expired
                          ? const Skeleton.line(width: 64, height: 18)
                          : AnimatedMoney(quote.fareMinor, locale: context.localeTag, style: AnbessaType.h2.copyWith(color: c.text)),
                      Text(l.fareFixed, style: AnbessaType.caption.copyWith(color: c.muted, fontSize: 11)),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
