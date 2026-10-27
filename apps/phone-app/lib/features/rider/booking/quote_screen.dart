// The choose-ride stage in the map shell (workflow 05 B–C). The map (drawn by the shell) shows the
// road growing from the pickup, "N min" at the pickup and "Arrive HH:MM" at the drop-off. The sheet:
// the route summary on top; a carousel of vehicle classes (our car art, seats, ETA, the price, the
// original struck through when a promo lowers it; the chosen one ringed in amber), the fare details
// to expand, the pickup time, payment, promo and a company ride's purpose; the amber
// "Request <class> · <price>" button at the bottom. Quotes last 10 minutes: the expiry counts down
// in its own small widget, and a new price is fetched when one expires. Changing a place refetches
// in place: skeleton cards while the old road stays on the map, dimmed.
// Also: booking for later (workflow 12, flag `scheduledRides`), a promo code (workflow 15, flag
// `promos`) and a company ride's purpose and policy refusal (workflow 11).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/routes.dart';
import '../../../core/session/session_controller.dart';
import '../../config/client_config_provider.dart';
import '../trip/active_trip_controller.dart';
import 'booking_actions.dart';
import 'booking_controller.dart';

/// The parts of the choose-ride stage the header, body and footer share.
@immutable
class QuoteUi {
  const QuoteUi({this.requesting = false, this.error, this.expiredQuote});
  final bool requesting;
  final Object? error;
  /// the id of a quote whose countdown reached zero
  final String? expiredQuote;
  bool get policyRefused => error is AppError && (error as AppError).code == ErrorCodes.policyViolation;
}

class QuoteUiController extends Notifier<QuoteUi> {
  @override
  QuoteUi build() => const QuoteUi();
  void reset() => state = const QuoteUi();
  void busy(bool v) => state = QuoteUi(requesting: v, error: v ? null : state.error, expiredQuote: state.expiredQuote);
  void fail(Object? e) => state = QuoteUi(requesting: state.requesting, error: e, expiredQuote: state.expiredQuote);
  void expired(String quoteId) => state = QuoteUi(requesting: state.requesting, error: state.error, expiredQuote: quoteId);
}

final quoteUiProvider = NotifierProvider<QuoteUiController, QuoteUi>(QuoteUiController.new);

/// The chosen quote has expired (by its clock, or its countdown ran out on screen).
bool quoteExpired(Quote? q, QuoteUi ui) => q != null && (q.isExpired(DateTime.now().toUtc()) || ui.expiredQuote == q.id);

/// The vehicle class's name from client-config (its code when unknown).
String vehicleName(ClientConfig cfg, String code) => cfg.vehicleTypes.where((v) => v.code == code).firstOrNull?.name ?? code;

/// The payment methods the rider may pick here (company billing when they belong to one).
List<PaymentMethod> offeredMethods(WidgetRef ref) {
  final methods = ref.watch(paymentMethodsProvider).value ?? PaymentMethodsConfig.fallback;
  final session = ref.watch(currentSessionProvider);
  final corporateOk = ref.watch(featureProvider(Feature.corporateBooking)) && (session?.claims.orgIds.isNotEmpty ?? false);
  return [...methods.methods.where((m) => m != PaymentMethod.corporate), if (corporateOk) PaymentMethod.corporate];
}

Future<void> _submit(BuildContext context, WidgetRef ref, Future<void> Function() action) async {
  final ui = ref.read(quoteUiProvider.notifier);
  Haptics.heavy();
  ui.busy(true);
  try {
    await action();
  } on AppError catch (e) {
    if (e.code == ErrorCodes.activeTripExists) {
      await ref.read(activeTripProvider.notifier).refresh();
      final t = ref.read(activeTripProvider).value;
      if (t != null && context.mounted) context.go(Routes.riderTrip(t.id));
      return;
    }
    if (e.code == ErrorCodes.quoteExpired || e.code == ErrorCodes.invalidQuote || e.code == ErrorCodes.quoteUsed) ref.read(bookingProvider.notifier).quote();
    Haptics.error();
    ui.fail(e);
  } catch (e) {
    Haptics.error();
    ui.fail(e);
  } finally {
    ui.busy(false);
  }
}

Future<void> requestRide(BuildContext context, WidgetRef ref) => _submit(context, ref, () async {
      final trip = await ref.read(bookingProvider.notifier).request();
      Haptics.success();
      if (context.mounted) context.go(Routes.riderTrip(trip.id));
    });

Future<void> scheduleRide(BuildContext context, WidgetRef ref) => _submit(context, ref, () async {
      final s = await ref.read(bookingProvider.notifier).schedule();
      Haptics.success();
      if (!context.mounted) return;
      showToast(context, context.l10n.scheduledBooked(dayAndTime(s.scheduledFor, locale: context.localeTag)), tone: NoticeTone.ok);
      context.go(Routes.riderActivity);
    });

/// The route on top of the sheet: pickup → drop-off, distance and time, Edit.
class QuoteHeader extends ConsumerWidget {
  const QuoteHeader({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final b = ref.watch(bookingProvider);
    final quote = b.quote;
    final summary = b.route ?? (quote == null ? null : QuoteRoute(polyline6: '', distanceMeters: quote.distanceMeters, durationSeconds: quote.durationSeconds, approximate: quote.approximate));
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Column(
            children: [
              Container(width: 10, height: 10, decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle)),
              Container(width: 2, height: 14, color: c.border),
              Container(width: 10, height: 10, decoration: BoxDecoration(color: c.text, borderRadius: BorderRadius.circular(2))),
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
              if (summary != null) Text(l.distanceTime(km(summary.distanceMeters), minutesOf(summary.durationSeconds)), style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)),
              TextButton(
                onPressed: () => context.pushReplacement('${Routes.riderRoute}?focus=dropoff'),
                style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: EdgeInsets.zero, minimumSize: const Size(48, 36)),
                child: Text(l.edit),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The classes, the fare details and the ride's options.
class QuoteSheet extends ConsumerStatefulWidget {
  const QuoteSheet({super.key});
  @override
  ConsumerState<QuoteSheet> createState() => _QuoteSheetState();
}

class _QuoteSheetState extends ConsumerState<QuoteSheet> {
  bool _detailsOpen = false;
  late final TextEditingController _purpose;

  @override
  void initState() {
    super.initState();
    final b = ref.read(bookingProvider);
    _purpose = TextEditingController(text: b.purpose);
    // after the first frame: providers can't change while the tree builds
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(quoteUiProvider.notifier).reset();
      final now = ref.read(bookingProvider);
      if (now.ready && now.quotes.isEmpty && !now.quoting) ref.read(bookingProvider.notifier).quote();
    });
  }

  @override
  void dispose() {
    _purpose.dispose();
    super.dispose();
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
            for (final m in offered) ChoiceRow(leading: Icon(_methodIcon(m)), title: paymentMethodLabel(l, m), selected: b.paymentMethod == m, onTap: () => Navigator.pop(ctx, m)),
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
    final ui = ref.watch(quoteUiProvider);
    final cfg = ref.watch(configProvider);
    final session = ref.watch(currentSessionProvider);
    final promos = ref.watch(featureProvider(Feature.promos));
    final schedulingOn = ref.watch(featureProvider(Feature.scheduledRides));
    final corporate = b.paymentMethod == PaymentMethod.corporate && b.billingOrgId != null;
    final policy = corporate ? ref.watch(corporatePolicyProvider(b.billingOrgId!)).value : null;
    final quote = b.quote;
    final expired = quoteExpired(quote, ui);
    final offered = offeredMethods(ref);
    if (!offered.contains(b.paymentMethod) && offered.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(bookingProvider.notifier).pay(offered.first));
    }
    final locale = context.localeTag;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (b.quoteError != null) Problem(b.quoteError, describe: (e) => describeError(l, e), onRetry: () => ref.read(bookingProvider.notifier).quote(), retryLabel: l.retry),
        if (quote?.approximate ?? false) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(l.estimateApproximate, tone: NoticeTone.info)),
        // the classes: skeletons while (re)quoting
        SingleChildScrollView(
          key: const ValueKey('classes'),
          scrollDirection: Axis.horizontal,
          clipBehavior: Clip.none,
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: b.quotes.isEmpty && (b.quoting || b.quoteError == null)
              ? Row(children: [for (var i = 0; i < 3; i++) const Padding(padding: EdgeInsets.only(right: 10), child: Skeleton.box(width: 132, height: 156, radius: AnbessaRadius.lg))])
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final (i, q) in b.quotes.indexed)
                      FadeSlideIn(
                        key: ValueKey('in-${q.vehicleType}'),
                        delay: Duration(milliseconds: 60 * i),
                        child: Padding(
                          padding: const EdgeInsets.only(right: 10),
                          child: Opacity(
                            opacity: expired ? 0.5 : 1,
                            child: VehicleClassCard(
                              key: ValueKey('class-${q.vehicleType}'),
                              code: q.vehicleType,
                              name: vehicleName(cfg, q.vehicleType),
                              fareMinor: q.fareMinor,
                              payableMinor: q.payableMinor,
                              seats: cfg.vehicleTypes.where((v) => v.code == q.vehicleType).firstOrNull?.seatsMax,
                              etaSeconds: q.etaToPickupSeconds,
                              // the ETA is about now: none when booking for later
                              minuteLabel: b.scheduling ? null : (m) => l.rideMinutes(m),
                              selected: q.vehicleType == b.vehicleType,
                              locale: locale,
                              onTap: () {
                                Haptics.selection();
                                ref.read(bookingProvider.notifier).choose(q.vehicleType);
                              },
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
        ),
        if (quote != null) ...[
          // the details of the chosen class, folded
          InkWell(
            key: const ValueKey('fare-details'),
            borderRadius: BorderRadius.circular(AnbessaRadius.md),
            onTap: () => setState(() => _detailsOpen = !_detailsOpen),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
              child: Row(
                children: [
                  Icon(Icons.receipt_long_rounded, size: 18, color: c.muted),
                  const SizedBox(width: 8),
                  Expanded(child: Text(l.fareBreakdown, style: AnbessaType.body2.copyWith(fontWeight: FontWeight.w600, color: c.text))),
                  Text(l.fareFixed, style: AnbessaType.caption.copyWith(color: c.muted)),
                  AnimatedRotation(turns: _detailsOpen ? 0.5 : 0, duration: AnbessaMotion.of(context, AnbessaMotion.base), child: Icon(Icons.expand_more_rounded, color: c.muted)),
                ],
              ),
            ),
          ),
          AnimatedSwitcherX(
            child: !_detailsOpen
                ? const SizedBox.shrink(key: ValueKey('nodetails'))
                : Padding(
                    key: const ValueKey('details'),
                    padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
                    child: Column(
                      children: [
                        _InfoRow(l.distanceTime(km(quote.distanceMeters), minutesOf(quote.durationSeconds)), null),
                        if (quote.breakdown != null) ...[
                          _BdRow(l.baseFare, quote.breakdown!.baseMinor),
                          _BdRow(l.distanceFare, quote.breakdown!.distanceMinor),
                          _BdRow(l.timeFare, quote.breakdown!.timeMinor),
                        ],
                        if (quote.discounted) _BdRow(l.promoCode, -quote.discountMinor),
                        if (quote.breakdown?.minimumApplied ?? false) Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.minimumFareApplied, style: AnbessaType.caption.copyWith(color: c.muted))),
                      ],
                    ),
                  ),
          ),
          const SizedBox(height: 4),
          SectionGroup(
            margin: EdgeInsets.zero,
            children: [
              if (schedulingOn) SettingsValueTile(icon: Icons.schedule_rounded, title: l.pickupTime, value: b.scheduling ? dayAndTime(b.scheduledFor, locale: locale) : l.now, onTap: () => chooseRideTime(context, ref)),
              SettingsValueTile(icon: _methodIcon(b.paymentMethod), title: l.paymentMethod, value: paymentMethodLabel(l, b.paymentMethod), onTap: offered.length > 1 ? () => _choosePayment(offered, session) : null),
              if (promos) SettingsValueTile(icon: Icons.local_offer_rounded, title: l.promoCode, value: b.promoCode ?? l.promoAdd, onTap: b.quoting ? null : _enterPromo),
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
                if (ui.policyRefused) ref.read(quoteUiProvider.notifier).fail(null);
              },
              decoration: InputDecoration(labelText: l.purposeLabel, helperText: (policy?.requirePurpose ?? false) ? l.purposeRequired : l.purposeOptional, counterText: ''),
            ),
          ],
          if (b.scheduling) Padding(padding: const EdgeInsets.only(top: 10), child: Text(l.scheduleRepriceNote, style: AnbessaType.caption.copyWith(color: c.muted))),
          const SizedBox(height: 10),
          // the expiry counts down by itself; only its end rebuilds the sheet
          if (expired)
            Text(l.quoteExpired, style: AnbessaType.caption.copyWith(color: c.danger))
          else
            Countdown(
              key: ValueKey('expiry-${quote.id}'),
              until: quote.expiresAt,
              format: (d) => l.quoteExpiresIn(mmss(d)),
              style: AnbessaType.caption.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular),
              onDone: () => ref.read(quoteUiProvider.notifier).expired(quote.id),
            ),
        ],
      ],
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.label, this.value);
  final String label;
  final String? value;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(children: [Expanded(child: Text(label, style: AnbessaType.body2.copyWith(color: c.text2))), if (value != null) Text(value!, style: AnbessaType.body2.copyWith(color: c.text))]),
    );
  }
}

/// Notices and the amber Request (or Schedule) button, pinned under the sheet.
class QuoteFooter extends ConsumerWidget {
  const QuoteFooter({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final b = ref.watch(bookingProvider);
    final ui = ref.watch(quoteUiProvider);
    final cfg = ref.watch(configProvider);
    final paused = cfg.maintenance.newTripsPaused;
    final quote = b.quote;
    final expired = quoteExpired(quote, ui);
    final corporate = b.paymentMethod == PaymentMethod.corporate && b.billingOrgId != null;
    final policy = corporate ? ref.watch(corporatePolicyProvider(b.billingOrgId!)).value : null;
    final purposeMissing = corporate && (policy?.requirePurpose ?? false) && b.purpose.trim().isEmpty;
    final offered = offeredMethods(ref);
    final name = vehicleName(cfg, quote?.vehicleType ?? '');
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (paused) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(cfg.maintenance.message.isEmpty ? l.newTripsPaused : cfg.maintenance.message, tone: NoticeTone.warning)),
        if (ui.policyRefused) ...[
          Notice(describeError(l, ui.error), tone: NoticeTone.error),
          if (offered.any((m) => m != PaymentMethod.corporate))
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(
                onPressed: () {
                  // the same ride on the first personal method
                  final m = offered.where((x) => x != PaymentMethod.corporate).firstOrNull;
                  if (m == null) return;
                  ref.read(bookingProvider.notifier).pay(m);
                  ref.read(quoteUiProvider.notifier).fail(null);
                },
                style: TextButton.styleFrom(visualDensity: VisualDensity.compact, padding: const EdgeInsets.symmetric(horizontal: 8)),
                child: Text(l.payPersonally),
              ),
            ),
        ] else
          Problem(ui.error, describe: (e) => describeError(l, e)),
        if (ui.error != null && !ui.policyRefused) const SizedBox(height: 10),
        if (b.quotes.isEmpty && !b.quoting)
          const SizedBox.shrink()
        else if (expired)
          PrimaryButton(label: l.getNewQuote, icon: Icons.refresh_rounded, onPressed: () => ref.read(bookingProvider.notifier).quote())
        else
          PrimaryButton(
            label: b.scheduling ? l.scheduleFor(name) : l.requestRide(name),
            trailing: quote == null ? null : birr(quote.payableMinor, locale: context.localeTag),
            busy: ui.requesting || b.quoting,
            onPressed: paused || quote == null || purposeMissing ? null : () => b.scheduling ? scheduleRide(context, ref) : requestRide(context, ref),
          ),
      ],
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
