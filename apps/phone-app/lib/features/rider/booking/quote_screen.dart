// Choosing the ride (workflow 05 B–C): the route on the map, one card per vehicle type with its
// ETA and fixed price, the fare breakdown, the payment method, and Request. Quotes last 10
// minutes; a new price is fetched when one expires. Also: a pickup time to book the ride for
// later (workflow 12, flag `scheduledRides`), a promo code (workflow 15, flag `promos`) whose
// discount shows on the cards and the button, and a company ride's purpose (workflow 11).

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
  late final TextEditingController _purpose;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => setState(() => _now = DateTime.now().toUtc()));
    final b = ref.read(bookingProvider);
    _purpose = TextEditingController(text: b.purpose);
    // after the first frame: providers can't change while the tree builds
    if (b.ready && b.quotes.isEmpty && !b.quoting) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ref.read(bookingProvider.notifier).quote();
      });
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    _purpose.dispose();
    super.dispose();
  }

  Future<void> _request() => _submit(() async {
        final trip = await ref.read(bookingProvider.notifier).request();
        Haptics.success();
        if (mounted) context.go(Routes.riderTrip(trip.id));
      });

  Future<void> _schedule() => _submit(() async {
        final s = await ref.read(bookingProvider.notifier).schedule();
        Haptics.success();
        if (!mounted) return;
        showToast(context, context.l10n.scheduledBooked(dayAndTime(s.scheduledFor, locale: context.localeTag)), tone: NoticeTone.ok);
        context.go(Routes.riderActivity);
      });

  Future<void> _submit(Future<void> Function() action) async {
    Haptics.heavy();
    setState(() {
      _requesting = true;
      _error = null;
    });
    try {
      await action();
    } on AppError catch (e) {
      if (e.code == ErrorCodes.activeTripExists) {
        await ref.read(activeTripProvider.notifier).refresh();
        final t = ref.read(activeTripProvider).value;
        if (t != null && mounted) context.go(Routes.riderTrip(t.id));
        return;
      }
      if (e.code == ErrorCodes.quoteExpired || e.code == ErrorCodes.invalidQuote || e.code == ErrorCodes.quoteUsed) ref.read(bookingProvider.notifier).quote();
      Haptics.error();
      setState(() => _error = e);
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
  }

  /// Now, or a time within the booking window (Addis time, like every time the app shows).
  Future<void> _chooseTime() async {
    final l = context.l10n;
    final b = ref.read(bookingProvider);
    final later = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(padding: const EdgeInsets.fromLTRB(20, 4, 20, 8), child: Align(alignment: Alignment.centerLeft, child: Text(l.pickupTime, style: AnbessaType.h2.copyWith(color: ctx.colors.text)))),
            ChoiceRow(title: l.now, selected: !b.scheduling, onTap: () => Navigator.pop(ctx, false)),
            ChoiceRow(title: l.scheduleWhen, subtitle: b.scheduling ? dayAndTime(b.scheduledFor, locale: context.localeTag) : null, selected: b.scheduling, onTap: () => Navigator.pop(ctx, true)),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (later == null || !mounted) return;
    if (!later) return ref.read(bookingProvider.notifier).scheduleAt(null);
    const w = ScheduleWindow.tripService;
    final now = DateTime.now().toUtc();
    final current = toAddis(b.scheduledFor ?? w.suggested(now));
    final first = toAddis(w.earliest(now));
    final last = toAddis(w.latest(now));
    final day = await showDatePicker(
      context: context,
      initialDate: DateTime(current.year, current.month, current.day),
      firstDate: DateTime(first.year, first.month, first.day),
      lastDate: DateTime(last.year, last.month, last.day),
    );
    if (day == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay(hour: current.hour, minute: current.minute));
    if (time == null || !mounted) return;
    // the picked wall time is Addis time
    final at = DateTime.utc(day.year, day.month, day.day, time.hour, time.minute).subtract(addisOffset);
    final problem = w.check(at, DateTime.now().toUtc());
    if (problem != null) {
      Haptics.error();
      showToast(context, describeError(l, AppError(status: 400, code: problem, message: problem)), tone: NoticeTone.warning);
      return;
    }
    Haptics.selection();
    ref.read(bookingProvider.notifier).scheduleAt(at);
  }

  Future<void> _enterPromo() async {
    final b = ref.read(bookingProvider);
    final code = await showModalBottomSheet<String>(context: context, isScrollControlled: true, builder: (ctx) => _PromoSheet(initial: b.promoCode ?? b.promo?.code ?? '', applied: b.promoCode != null));
    if (code == null || !mounted) return;
    final booking = ref.read(bookingProvider.notifier);
    if (code.isEmpty) return booking.removePromo();
    await booking.applyPromo(code);
    final outcome = ref.read(bookingProvider).promo;
    if (outcome != null) outcome.applied ? Haptics.success() : Haptics.error();
  }

  /// After a company policy refusal: the same ride on the first personal method.
  void _payPersonally(List<PaymentMethod> offered) {
    final m = offered.where((x) => x != PaymentMethod.corporate).firstOrNull;
    if (m == null) return;
    ref.read(bookingProvider.notifier).pay(m);
    setState(() => _error = null);
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
    final schedulingOn = ref.watch(featureProvider(Feature.scheduledRides));
    final corporate = b.paymentMethod == PaymentMethod.corporate && b.billingOrgId != null;
    final policy = corporate ? ref.watch(corporatePolicyProvider(b.billingOrgId!)).value : null;
    final purposeMissing = corporate && (policy?.requirePurpose ?? false) && b.purpose.trim().isEmpty;
    final policyRefused = _error is AppError && (_error as AppError).code == ErrorCodes.policyViolation;
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
                if (policyRefused) ...[
                  Notice(describeError(l, _error), tone: NoticeTone.error),
                  if (offered.any((m) => m != PaymentMethod.corporate)) Align(alignment: AlignmentDirectional.centerEnd, child: TextButton(onPressed: () => _payPersonally(offered), style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8)), child: Text(l.payPersonally))),
                ] else
                  Problem(_error, describe: (e) => describeError(l, e)),
                if (_error != null && !policyRefused) const SizedBox(height: 10),
                if (b.quotes.isEmpty && !b.quoting)
                  const SizedBox.shrink()
                else if (expired)
                  PrimaryButton(label: l.getNewQuote, icon: Icons.refresh, onPressed: () => ref.read(bookingProvider.notifier).quote())
                else
                  PrimaryButton(
                    label: b.scheduling ? l.scheduleFor(nameOf(quote?.vehicleType ?? '')) : l.requestRide(nameOf(quote?.vehicleType ?? '')),
                    trailing: quote == null ? null : birr(quote.payableMinor, locale: context.localeTag),
                    busy: _requesting || b.quoting,
                    onPressed: paused || quote == null || purposeMissing ? null : (b.scheduling ? _schedule : _request),
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
                        showEta: !b.scheduling,
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
                                  if (quote.discounted) _BdRow(l.promoCode, -quote.discountMinor),
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
                      if (schedulingOn) SettingsValueTile(icon: Icons.schedule, title: l.pickupTime, value: b.scheduling ? dayAndTime(b.scheduledFor, locale: context.localeTag) : l.now, onTap: _chooseTime),
                      SettingsValueTile(icon: _methodIcon(b.paymentMethod), title: l.paymentMethod, value: paymentMethodLabel(l, b.paymentMethod), onTap: offered.length > 1 ? () => _choosePayment(offered, session) : null),
                      if (promos) SettingsValueTile(icon: Icons.local_offer_outlined, title: l.promoCode, value: b.promoCode ?? l.promoAdd, onTap: b.quoting ? null : _enterPromo),
                    ],
                  ),
                  if (promos && b.promo != null) Padding(padding: const EdgeInsets.fromLTRB(4, 8, 4, 0), child: _PromoLine(outcome: b.promo!, quote: quote)),
                  if (corporate) ...[
                    const SizedBox(height: 10),
                    TextField(
                      controller: _purpose,
                      maxLength: 200,
                      onChanged: (v) {
                        ref.read(bookingProvider.notifier).setPurpose(v);
                        if (policyRefused) setState(() => _error = null);
                      },
                      decoration: InputDecoration(labelText: l.purposeLabel, helperText: (policy?.requirePurpose ?? false) ? l.purposeRequired : l.purposeOptional, counterText: ''),
                    ),
                  ],
                  if (b.scheduling) Padding(padding: const EdgeInsets.only(top: 10), child: Text(l.scheduleRepriceNote, style: AnbessaType.caption.copyWith(color: c.muted))),
                  const SizedBox(height: 10),
                  if (quote != null)
                    Text(expired ? l.quoteExpired : l.quoteExpiresIn(mmss(quote.expiresAt.difference(_now))), style: AnbessaType.caption.copyWith(color: expired ? c.danger : c.muted, fontFeatures: AnbessaType.tabular)),
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
              Container(width: 10, height: 10, decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle)),
              Container(width: 2, height: 14, color: c.border),
              Container(width: 10, height: 10, color: c.text),
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
  const _QuoteCard({required this.name, required this.quote, required this.selected, required this.onTap, this.seats, this.expired = false, this.showEta = true});
  final String name;
  final int? seats;
  final Quote quote;
  final bool selected;
  final bool expired;
  /// hidden when booking for later (the ETA is about now)
  final bool showEta;
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
          color: c.surface,
          borderRadius: BorderRadius.circular(AnbessaRadius.lg),
          child: InkWell(
            borderRadius: BorderRadius.circular(AnbessaRadius.lg),
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: Border.all(color: selected ? c.text : c.border, width: selected ? 2 : 1)),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // wraps rather than overflows on a small phone with large text
                        Wrap(
                          spacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.end,
                          children: [
                            Text(name, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                            if (seats != null) Text('$seats ${l.seats.toLowerCase()}', style: AnbessaType.caption.copyWith(color: c.muted)),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Wrap(
                          spacing: 6,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            if (showEta) FittedBox(fit: BoxFit.scaleDown, alignment: AlignmentDirectional.centerStart, child: EtaBadge(seconds: quote.etaToPickupSeconds, minuteLabel: (m) => l.etaMinutes(m), icon: Icons.schedule)),
                            Text(l.distanceTime(km(quote.distanceMeters), minutesOf(quote.durationSeconds)), style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  // at most half the card, so the name and ETA keep their room
                  Flexible(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        expired
                            ? const Skeleton.line(width: 64, height: 18)
                            : FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerRight, child: PriceTag(fareMinor: quote.fareMinor, payableMinor: quote.payableMinor, locale: context.localeTag, style: AnbessaType.h2.copyWith(color: c.text))),
                        Text(l.fareFixed, textAlign: TextAlign.end, style: AnbessaType.caption.copyWith(color: c.muted, fontSize: 11)),
                      ],
                    ),
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

/// Under the promo row: applied (and what it saves on the chosen ride), or why it wasn't.
class _PromoLine extends StatelessWidget {
  const _PromoLine({required this.outcome, required this.quote});
  final PromoOutcome outcome;
  final Quote? quote;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    if (!outcome.applied) return Text(promoRejectionText(l, outcome), style: AnbessaType.body2.copyWith(color: c.danger));
    final q = quote;
    final text = q != null && q.discounted ? '${l.promoApplied(outcome.code)} · ${l.promoSaves(birr(q.discountMinor, locale: context.localeTag))}' : l.promoNotForThisRide(outcome.code);
    return Text(text, style: AnbessaType.body2.copyWith(color: q != null && q.discounted ? c.success : c.muted));
  }
}

/// Type a code, Apply; or remove the one in use. Pops the code, '' to remove, null to leave.
class _PromoSheet extends StatefulWidget {
  const _PromoSheet({required this.initial, required this.applied});
  final String initial;
  final bool applied;
  @override
  State<_PromoSheet> createState() => _PromoSheetState();
}

class _PromoSheetState extends State<_PromoSheet> {
  late final _code = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l.promoCode, style: AnbessaType.h2.copyWith(color: c.text)),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('promo-code'),
              controller: _code,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              maxLength: 32,
              decoration: InputDecoration(hintText: l.promoCodeHint, counterText: ''),
              onChanged: (_) => setState(() {}),
              onSubmitted: (v) => v.trim().isEmpty ? null : Navigator.pop(context, v.trim()),
            ),
            const SizedBox(height: 12),
            PrimaryButton(label: l.apply, onPressed: _code.text.trim().isEmpty ? null : () => Navigator.pop(context, _code.text.trim())),
            if (widget.applied) TextButton(onPressed: () => Navigator.pop(context, ''), child: Text(l.promoRemove)),
          ],
        ),
      ),
    );
  }
}
