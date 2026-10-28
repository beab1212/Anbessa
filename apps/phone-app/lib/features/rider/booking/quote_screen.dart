// The choose-ride stage in the map shell (workflow 05 B–C), drawn as the GoRide kit's "choose
// ride": the route card (pickup, destination) over the map, where the road grows from the pickup
// with "N min" at the pickup and "Arrive HH:MM" at the drop-off; a back button above the sheet.
// The sheet: the vehicle classes as rows (our car art, name, "4 min · 4 passengers", the price;
// a promo's price with a seal and the old one struck through; the chosen one tinted with an
// amber border), then "Payment  Cash ›", "Promos / Vouchers ›" with the code in use, the pickup
// time when booking for later, the fare details to fold out, and a company ride's purpose. At
// the bottom: the round calendar (book for later) and "Book <class>". Quotes last 10 minutes:
// the expiry counts down in its own small widget, and a new price is fetched when one expires.
// Changing a place refetches in place: skeleton rows while the old road stays on the map, dimmed.
// "Choose Payment Method" and "Promos / Vouchers" are pages of their own (the kit's, without
// wallets or a voucher list).
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
import '../shell/map_intent.dart' show minutesCeil;
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

/// The route over the map: pickup and destination; a tap edits that place.
class QuoteRouteCard extends ConsumerWidget {
  const QuoteRouteCard({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final b = ref.watch(bookingProvider);
    void edit(String focus) => context.pushReplacement('${Routes.riderRoute}?focus=$focus');
    return RoutePointsCard(
      points: [
        RoutePointsCard.pickup(b.pickup?.name ?? l.pickupLabel, onTap: () => edit('pickup')),
        RoutePointsCard.destination(b.dropoff?.name ?? l.dropoffLabel, onTap: () => edit('dropoff')),
      ],
    );
  }
}

/// A row of the choose-ride sheet: "Payment ……… Cash ›".
class _OptionRow extends StatelessWidget {
  const _OptionRow({super.key, required this.title, this.value, this.valueWidget, this.onTap, this.chevron = true});
  final String title;
  final String? value;
  final Widget? valueWidget;
  final VoidCallback? onTap;
  final bool chevron;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: onTap != null,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AnbessaRadius.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Row(
            children: [
              Expanded(child: Text(title, style: AnbessaType.body.copyWith(color: c.text, fontWeight: FontWeight.w600))),
              if (value != null) ...[
                const SizedBox(width: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 150),
                  child: Text(value!, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.end, style: AnbessaType.body2.copyWith(color: c.text, fontWeight: FontWeight.w600)),
                ),
              ],
              if (valueWidget != null) ...[const SizedBox(width: 8), valueWidget!],
              if (chevron) ...[const SizedBox(width: 6), ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, color: onTap == null ? c.faint : c.text))],
            ],
          ),
        ),
      ),
    );
  }
}

/// The classes, the payment and promo rows, the fare details and the ride's options.
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
    final code = await Navigator.of(context, rootNavigator: true).push<String>(MaterialPageRoute(builder: (_) => PromoCodePage(initial: b.promoCode ?? b.promo?.code ?? '', applied: b.promoCode)));
    if (code == null || !mounted) return;
    final booking = ref.read(bookingProvider.notifier);
    if (code.isEmpty) return booking.removePromo();
    await booking.applyPromo(code);
    final outcome = ref.read(bookingProvider).promo;
    if (outcome != null) outcome.applied ? Haptics.success() : Haptics.error();
  }

  Future<void> _choosePayment(List<PaymentMethod> offered, Session? session) async {
    final b = ref.read(bookingProvider);
    final picked = await Navigator.of(context, rootNavigator: true).push<PaymentMethod>(MaterialPageRoute(builder: (_) => ChoosePaymentPage(offered: offered, selected: b.paymentMethod)));
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
    final corporate = b.paymentMethod == PaymentMethod.corporate && b.billingOrgId != null;
    final policy = corporate ? ref.watch(corporatePolicyProvider(b.billingOrgId!)).value : null;
    final quote = b.quote;
    final expired = quoteExpired(quote, ui);
    final offered = offeredMethods(ref);
    if (!offered.contains(b.paymentMethod) && offered.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(bookingProvider.notifier).pay(offered.first));
    }
    final locale = context.localeTag;
    int? seatsOf(String code) => cfg.vehicleTypes.where((v) => v.code == code).firstOrNull?.seatsMax;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (b.quoteError != null) Padding(padding: const EdgeInsets.only(bottom: 10), child: Problem(b.quoteError, describe: (e) => describeError(l, e), onRetry: () => ref.read(bookingProvider.notifier).quote(), retryLabel: l.retry)),
        if (quote?.approximate ?? false) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(l.estimateApproximate, tone: NoticeTone.info)),
        // the classes: skeletons while (re)quoting
        if (b.quotes.isEmpty && (b.quoting || b.quoteError == null))
          for (var i = 0; i < 3; i++) const Padding(padding: EdgeInsets.only(bottom: 12), child: Skeleton.box(height: 76, radius: AnbessaRadius.md))
        else
          for (final (i, q) in b.quotes.indexed)
            FadeSlideIn(
              key: ValueKey('in-${q.vehicleType}'),
              delay: Duration(milliseconds: 50 * i),
              child: Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Opacity(
                  opacity: expired ? 0.5 : 1,
                  child: RideClassTile(
                    key: ValueKey('class-${q.vehicleType}'),
                    code: q.vehicleType,
                    name: vehicleName(cfg, q.vehicleType),
                    fareMinor: q.fareMinor,
                    payableMinor: q.payableMinor,
                    // the ETA is about now: none when booking for later
                    etaLabel: b.scheduling || q.etaToPickupSeconds == null ? null : l.rideMinutes(minutesCeil(q.etaToPickupSeconds!)),
                    seatsLabel: seatsOf(q.vehicleType) == null ? null : l.grPassengers(seatsOf(q.vehicleType)!),
                    selected: q.vehicleType == b.vehicleType,
                    locale: locale,
                    onTap: () => ref.read(bookingProvider.notifier).choose(q.vehicleType),
                  ),
                ),
              ),
            ),
        if (quote != null) ...[
          Divider(height: 12, color: c.border),
          _OptionRow(
            key: const ValueKey('payment-row'),
            title: l.grPayment,
            value: paymentMethodLabel(l, b.paymentMethod),
            onTap: offered.length > 1 ? () => _choosePayment(offered, session) : null,
            chevron: offered.length > 1,
          ),
          if (promos)
            _OptionRow(
              key: const ValueKey('promo-row'),
              title: l.grPromosVouchers,
              valueWidget: b.promoCode == null ? null : OutlineBadge(b.promoCode!),
              onTap: b.quoting ? null : _enterPromo,
            ),
          if (promos && b.promo != null) Padding(padding: const EdgeInsets.only(bottom: 6), child: _PromoLine(outcome: b.promo!, quote: quote)),
          if (b.scheduling) _OptionRow(title: l.pickupTime, value: dayAndTime(b.scheduledFor, locale: locale), onTap: () => chooseRideTime(context, ref)),
          _OptionRow(
            key: const ValueKey('fare-details'),
            title: l.grFareDetails,
            value: l.fareFixed,
            onTap: () => setState(() => _detailsOpen = !_detailsOpen),
            chevron: false,
            valueWidget: AnimatedRotation(turns: _detailsOpen ? 0.5 : 0, duration: AnbessaMotion.of(context, AnbessaMotion.base), child: Icon(Icons.expand_more_rounded, color: c.muted)),
          ),
          AnimatedSwitcherX(
            child: !_detailsOpen
                ? const SizedBox.shrink(key: ValueKey('nodetails'))
                : Padding(
                    key: const ValueKey('details'),
                    padding: const EdgeInsets.only(bottom: 8),
                    child: KeyValueCard(
                      rows: [
                        KeyValueCard.row(l.grDistance, km(quote.distanceMeters)),
                        KeyValueCard.row(l.grDuration, minutesOf(quote.durationSeconds)),
                        if (quote.breakdown != null) ...[
                          KeyValueCard.row(l.baseFare, birr(quote.breakdown!.baseMinor, locale: locale)),
                          KeyValueCard.row(l.distanceFare, birr(quote.breakdown!.distanceMinor, locale: locale)),
                          KeyValueCard.row(l.timeFare, birr(quote.breakdown!.timeMinor, locale: locale)),
                        ],
                        if (quote.discounted) KeyValueCard.row(l.grDiscounts, '−${birr(quote.discountMinor, locale: locale)}', valueColor: c.success),
                      ],
                      total: KeyValueCard.row(l.totalLabel, birr(quote.payableMinor, locale: locale)),
                    ),
                  ),
          ),
          if (quote.breakdown?.minimumApplied ?? false) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(l.minimumFareApplied, style: AnbessaType.caption.copyWith(color: c.muted))),
          if (corporate) ...[
            const SizedBox(height: 8),
            FilledField(
              controller: _purpose,
              maxLength: 200,
              hint: l.purposeLabel,
              onChanged: (v) {
                ref.read(bookingProvider.notifier).setPurpose(v);
                if (ui.policyRefused) ref.read(quoteUiProvider.notifier).fail(null);
              },
            ),
            const SizedBox(height: 4),
            Text((policy?.requirePurpose ?? false) ? l.purposeRequired : l.purposeOptional, style: AnbessaType.caption.copyWith(color: c.muted)),
          ],
          if (b.scheduling) Padding(padding: const EdgeInsets.only(top: 10), child: Text(l.scheduleRepriceNote, style: AnbessaType.caption.copyWith(color: c.muted))),
          const SizedBox(height: 8),
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

/// Notices, the round calendar (book for later) and "Book Economy", pinned under the sheet.
class QuoteFooter extends ConsumerWidget {
  const QuoteFooter({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final b = ref.watch(bookingProvider);
    final ui = ref.watch(quoteUiProvider);
    final cfg = ref.watch(configProvider);
    final schedulingOn = ref.watch(featureProvider(Feature.scheduledRides));
    final paused = cfg.maintenance.newTripsPaused;
    final quote = b.quote;
    final expired = quoteExpired(quote, ui);
    final corporate = b.paymentMethod == PaymentMethod.corporate && b.billingOrgId != null;
    final policy = corporate ? ref.watch(corporatePolicyProvider(b.billingOrgId!)).value : null;
    final purposeMissing = corporate && (policy?.requirePurpose ?? false) && b.purpose.trim().isEmpty;
    final offered = offeredMethods(ref);
    final name = vehicleName(cfg, quote?.vehicleType ?? '');
    final Widget main;
    if (b.quotes.isEmpty && !b.quoting) {
      main = const SizedBox.shrink();
    } else if (expired) {
      main = PrimaryButton(label: l.getNewQuote, icon: Icons.refresh_rounded, onPressed: () => ref.read(bookingProvider.notifier).quote());
    } else {
      main = PrimaryButton(
        label: b.scheduling ? l.scheduleFor(name) : l.grBook(name),
        busy: ui.requesting || b.quoting,
        onPressed: paused || quote == null || purposeMissing ? null : () => b.scheduling ? scheduleRide(context, ref) : requestRide(context, ref),
      );
    }
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
        Row(
          children: [
            if (schedulingOn && !expired) ...[
              CircleActionButton(key: const ValueKey('schedule-button'), icon: Icons.calendar_month_outlined, size: 56, tooltip: l.grScheduleRide, onTap: () => chooseRideTime(context, ref)),
              const SizedBox(width: 12),
            ],
            Expanded(child: main),
          ],
        ),
      ],
    );
  }
}

/// The kit's "Choose Payment Method": our methods as cards (an icon, the name, a line about it),
/// the chosen one tinted with a check; OK takes it.
class ChoosePaymentPage extends ConsumerStatefulWidget {
  const ChoosePaymentPage({super.key, required this.offered, required this.selected});
  final List<PaymentMethod> offered;
  final PaymentMethod selected;
  @override
  ConsumerState<ChoosePaymentPage> createState() => _ChoosePaymentPageState();
}

class _ChoosePaymentPageState extends ConsumerState<ChoosePaymentPage> {
  late PaymentMethod _picked = widget.selected;

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final providers = ref.watch(paymentMethodsProvider).value?.providers ?? const <PaymentProvider>[];
    String sub(PaymentMethod m) => switch (m) {
          PaymentMethod.cash => l.grCashSub,
          PaymentMethod.mobileMoney => providers.where((p) => p.takesMobileMoney).map((p) => p.label).join(', ').ifEmpty(l.grMobileMoneySub),
          PaymentMethod.card => l.grCardSub,
          PaymentMethod.corporate => l.grCorporateSub,
          _ => '',
        };
    return Scaffold(
      backgroundColor: c.groupedPage,
      appBar: AppTopBar(title: l.grChoosePaymentMethod, background: c.groupedPage),
      body: ListView.separated(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        itemCount: widget.offered.length,
        separatorBuilder: (_, _) => const SizedBox(height: 16),
        itemBuilder: (_, i) {
          final m = widget.offered[i];
          return SelectableCard(
            key: ValueKey('method-${m.name}'),
            selected: _picked == m,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 20),
            onTap: () => setState(() => _picked = m),
            child: Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: m == PaymentMethod.cash ? c.success : c.primaryFill),
                  child: Icon(methodIcon(m), color: m == PaymentMethod.cash ? Colors.white : c.onAccent, size: 24),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(paymentMethodLabel(l, m), style: AnbessaType.title.copyWith(color: c.text)),
                      if (sub(m).isNotEmpty) ...[const SizedBox(height: 4), Text(sub(m), maxLines: 2, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted))],
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      ),
      bottomNavigationBar: BottomActionBar(child: PrimaryButton(label: l.ok, onPressed: () => Navigator.of(context).pop(_picked))),
    );
  }
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}

IconData methodIcon(PaymentMethod m) => switch (m) {
      PaymentMethod.cash => Icons.attach_money_rounded,
      PaymentMethod.mobileMoney => Icons.phone_iphone_rounded,
      PaymentMethod.card => Icons.credit_card_rounded,
      PaymentMethod.corporate => Icons.business_center_rounded,
      _ => Icons.payment_rounded,
    };


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

/// The kit's "Promos / Vouchers" with only its "Have a Promo Code?" card: type a code and Redeem;
/// the code in use shows as a chosen card with Remove. Pops the code, '' to remove, null to leave.
class PromoCodePage extends StatefulWidget {
  const PromoCodePage({super.key, required this.initial, this.applied});
  final String initial;
  /// the code in use now
  final String? applied;
  @override
  State<PromoCodePage> createState() => _PromoCodePageState();
}

class _PromoCodePageState extends State<PromoCodePage> {
  late final _code = TextEditingController(text: widget.applied == null ? widget.initial : '');

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  void _redeem() {
    final v = _code.text.trim();
    if (v.isNotEmpty) Navigator.pop(context, v);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final ready = _code.text.trim().isNotEmpty;
    return Scaffold(
      backgroundColor: c.groupedPage,
      appBar: AppTopBar(title: l.grPromosVouchers, background: c.groupedPage),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          AppCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(l.grHaveAPromoCode, style: AnbessaType.title.copyWith(color: c.text)),
                Divider(height: 25, color: c.border),
                Row(
                  children: [
                    Expanded(
                      child: FilledField(
                        key: const ValueKey('promo-code'),
                        controller: _code,
                        hint: l.grEnterCodeHere,
                        autofocus: widget.applied == null,
                        textCapitalization: TextCapitalization.characters,
                        maxLength: 32,
                        onChanged: (_) => setState(() {}),
                        onSubmitted: (_) => _redeem(),
                      ),
                    ),
                    const SizedBox(width: 12),
                    PillButton(key: const ValueKey('promo-redeem'), label: l.grRedeem, compact: true, expand: false, onPressed: ready ? _redeem : null),
                  ],
                ),
              ],
            ),
          ),
          if (widget.applied != null) ...[
            const SizedBox(height: 16),
            SelectableCard(
              selected: true,
              child: Row(
                children: [
                  Container(width: 44, height: 44, decoration: BoxDecoration(shape: BoxShape.circle, color: c.primaryFill), child: Icon(Icons.local_offer_rounded, color: c.onAccent, size: 22)),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(widget.applied!, style: AnbessaType.title.copyWith(color: c.text)),
                        const SizedBox(height: 4),
                        Text(l.grCodeInUse, style: AnbessaType.caption.copyWith(color: c.muted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Align(alignment: AlignmentDirectional.centerEnd, child: TextButton(onPressed: () => Navigator.pop(context, ''), child: Text(l.promoRemove))),
          ],
        ],
      ),
      bottomNavigationBar: BottomActionBar(child: PrimaryButton(label: l.ok, onPressed: ready ? _redeem : () => Navigator.pop(context))),
    );
  }
}
