// Paying for a trip (workflow 08 A, D): cash is paid to the driver; mobile money and card are
// approved with the provider (the page opens in a Custom Tab / browser), and the screen follows
// `payment:*` events, a "Check status" button, and "Pay now" for a failed charge. Then the receipt
// and the rating.

import 'dart:async';

import 'package:confetti/confetti.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/realtime/realtime_hub.dart';
import '../../../core/router/routes.dart';
import '../trip/active_trip_controller.dart';
import 'payment_due_controller.dart';

/// Payments of a trip, updated by payment events and the "check" button.
class TripPaymentsController extends AsyncNotifier<TripPayments> {
  TripPaymentsController(this.tripId);
  final String tripId;
  StreamSubscription<RealtimeEvent>? _sub;
  String? instructions;

  @override
  Future<TripPayments> build() async {
    _sub?.cancel();
    _sub = ref.watch(realtimeHubProvider).events.listen((e) {
      final p = switch (e) {
        PaymentActionRequiredEvent(:final payment, :final instructions) => _withInstructions(payment, instructions),
        PaymentCapturedEvent(:final payment) => payment,
        PaymentFailedEvent(:final payment) => payment,
        _ => null,
      };
      if (p != null && p.tripId == tripId) _merge(p);
    });
    ref.onDispose(() => _sub?.cancel());
    return ref.read(apisProvider).payments.tripPayments(tripId);
  }

  Payment _withInstructions(Payment p, String? text) {
    if (text != null) instructions = text;
    return p;
  }

  void _merge(Payment p) {
    final cur = state.value ?? TripPayments.empty;
    final list = [for (final x in cur.payments) if (x.id != p.id) x, p];
    state = AsyncData(TripPayments(payments: list, settlements: cur.settlements));
  }

  Future<void> refresh() async {
    try {
      state = AsyncData(await ref.read(apisProvider).payments.tripPayments(tripId));
    } catch (_) {}
  }

  Future<Payment> payNow(String paymentId) async {
    final p = await ref.read(apisProvider).payments.payNow(paymentId, idempotencyKey: newIdempotencyKey());
    _merge(p);
    return p;
  }
}

final tripPaymentsProvider = AsyncNotifierProvider.family<TripPaymentsController, TripPayments, String>(TripPaymentsController.new);

class PayScreen extends ConsumerStatefulWidget {
  const PayScreen({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<PayScreen> createState() => _PayScreenState();
}

class _PayScreenState extends ConsumerState<PayScreen> {
  Timer? _poll;
  bool _busy = false;
  Object? _error;
  late final ConfettiController _confetti = ConfettiController(duration: const Duration(seconds: 2));
  bool _celebrated = false;

  @override
  void initState() {
    super.initState();
    // the provider page has no return URL: ask every 5 s while a payment is open
    _poll = Timer.periodic(const Duration(seconds: 5), (_) {
      final fare = ref.read(tripPaymentsProvider(widget.tripId)).value?.fare;
      if (fare != null && fare.isOpen) ref.read(tripPaymentsProvider(widget.tripId).notifier).refresh();
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _confetti.dispose();
    super.dispose();
  }

  Future<void> _open(String url) async {
    final uri = Uri.parse(url);
    final ok = await launchUrl(uri, mode: uri.scheme.startsWith('http') ? LaunchMode.inAppBrowserView : LaunchMode.externalApplication);
    if (!ok && mounted) setState(() => _error = AppError(status: 0, code: 'launch', message: context.l10n.errorGeneric));
  }

  Future<void> _payNow(Payment p) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final u = await ref.read(tripPaymentsProvider(widget.tripId).notifier).payNow(p.id);
      if (u.checkoutUrl != null) await _open(u.checkoutUrl!);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    // the Activity dot clears as soon as the fare goes through
    ref.listen(tripPaymentsProvider(widget.tripId), (prev, next) {
      final was = prev?.value?.fare, now = next.value?.fare;
      if (now != null && !now.isOpen && !now.isOwed && (was == null || was.isOpen || was.isOwed)) ref.invalidate(paymentDueProvider);
    });
    final trip = ref.watch(tripProvider(widget.tripId)).value;
    final paymentsAsync = ref.watch(tripPaymentsProvider(widget.tripId));
    final payments = paymentsAsync.value;
    final fare = payments?.fare;
    final instructions = ref.read(tripPaymentsProvider(widget.tripId).notifier).instructions;
    if (trip == null) return Scaffold(appBar: AppBar(title: Text(l.payTitle)), body: const Padding(padding: EdgeInsets.all(20), child: Column(children: [SkeletonCard(height: 140), SizedBox(height: 12), SkeletonCard(height: 200)])));
    if (fare?.isPaid == true && !_celebrated) {
      _celebrated = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Haptics.success();
        _confetti.play();
      });
    }

    Widget hero;
    if (!trip.isDigital) {
      hero = Column(
        children: [
          AnimatedMoney(trip.fare.payableMinor, locale: context.localeTag, style: AnbessaType.display.copyWith(color: c.text)),
          const SizedBox(height: 8),
          Text(trip.paymentMethod == PaymentMethod.cash ? l.payCashInstruction(birr(trip.fare.payableMinor, locale: context.localeTag)) : l.payCorporateInstruction, textAlign: TextAlign.center, style: AnbessaType.body.copyWith(color: c.text2)),
        ],
      );
    } else if (fare == null) {
      hero = Column(children: [const SizedBox(height: 8), const CircularProgressIndicator(), const SizedBox(height: 12), Text(paymentsAsync.hasError ? describeError(l, paymentsAsync.error) : l.paymentStarting, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2))]);
    } else {
      final provider = providerLabel(fare.provider);
      final step = switch (fare.status) {
        PaymentStatus.pending => 0,
        PaymentStatus.actionRequired => 1,
        PaymentStatus.succeeded || PaymentStatus.refunded || PaymentStatus.partiallyRefunded => 2,
        _ => -1,
      };
      hero = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(child: AnimatedMoney(fare.amountMinor, locale: context.localeTag, style: AnbessaType.display.copyWith(color: c.text))),
          const SizedBox(height: 4),
          Center(child: StatusPill(provider, tone: Tone.grey, icon: Icons.account_balance_wallet_outlined)),
          const SizedBox(height: 20),
          _Timeline(step: step, provider: provider, failed: step == -1),
          const SizedBox(height: 20),
          switch (fare.status) {
            PaymentStatus.actionRequired => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Notice(instructions ?? l.approveIn(provider), tone: NoticeTone.info),
                  const SizedBox(height: 12),
                  if (fare.checkoutUrl != null) PrimaryButton(label: l.openPaymentPage, icon: Icons.open_in_new, onPressed: () => _open(fare.checkoutUrl!)),
                  const SizedBox(height: 8),
                  Text(l.waitingForProvider(provider), textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ),
            PaymentStatus.pending => Column(children: [const LinearProgressIndicator(), const SizedBox(height: 8), Text(l.paymentStarting, style: AnbessaType.body2.copyWith(color: c.muted))]),
            PaymentStatus.retryScheduled => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Notice('${l.paymentFailed} ${l.paymentRetrying(clockOf(fare.nextAttemptAt))}', tone: NoticeTone.warning),
                  const SizedBox(height: 12),
                  PrimaryButton(label: l.payNow, busy: _busy, onPressed: () => _payNow(fare)),
                ],
              ),
            PaymentStatus.failed => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [Notice(l.paymentOwed, tone: NoticeTone.warning), const SizedBox(height: 12), PrimaryButton(label: l.payNow, busy: _busy, onPressed: () => _payNow(fare))],
              ),
            PaymentStatus.succeeded || PaymentStatus.refunded || PaymentStatus.partiallyRefunded => Notice(l.paymentPaid, tone: NoticeTone.ok),
            PaymentStatus.unknown => const SizedBox.shrink(),
          },
        ],
      );
    }

    final settled = !trip.isDigital || (fare?.isPaid ?? false) || (fare?.isOwed ?? false);
    return Scaffold(
      appBar: AppBar(title: Text(l.payTitle)),
      body: Stack(
        children: [
          ListView(
            padding: const EdgeInsets.all(20),
            children: [
              FloatingCard(padding: const EdgeInsets.all(20), child: hero),
              const SizedBox(height: 12),
              Problem(_error, describe: (e) => describeError(l, e)),
              if (trip.isDigital && fare != null && fare.isOpen) TextButton(onPressed: () => ref.read(tripPaymentsProvider(widget.tripId).notifier).refresh(), child: Text(l.checkStatus)),
              const SizedBox(height: 12),
              ReceiptCard(trip: trip),
              const SizedBox(height: 20),
              if (settled) PrimaryButton(label: l.rateTitle, icon: Icons.star_outline, onPressed: () => context.go(Routes.riderRate(trip.id))),
              TextButton(
                onPressed: () {
                  ref.read(activeTripProvider.notifier).clearIfEnded();
                  context.go(Routes.riderHome);
                },
                child: Text(l.done),
              ),
            ],
          ),
          Align(alignment: Alignment.topCenter, child: ConfettiWidget(confettiController: _confetti, blastDirectionality: BlastDirectionality.explosive, numberOfParticles: 24, colors: [c.accent, c.success, c.info])),
        ],
      ),
    );
  }
}

/// started → approve → paid
class _Timeline extends StatelessWidget {
  const _Timeline({required this.step, required this.provider, required this.failed});
  final int step;
  final String provider;
  final bool failed;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final labels = [l.paymentStepStarted, l.paymentStepApprove(provider), failed ? l.paymentStepFailed : l.paymentStepPaid];
    return Row(
      children: [
        for (var i = 0; i < 3; i++) ...[
          if (i > 0) Expanded(child: Container(height: 2, color: i <= step ? c.accent : c.border)),
          Column(
            children: [
              AnimatedContainer(
                duration: AnbessaMotion.of(context, AnbessaMotion.slow),
                width: 26,
                height: 26,
                decoration: BoxDecoration(shape: BoxShape.circle, color: failed && i == 2 ? c.dangerSoft : (i <= step ? c.primaryFill : c.surface), border: Border.all(color: failed && i == 2 ? c.danger : (i <= step ? c.primaryFill : c.borderStrong), width: 2)),
                child: Icon(failed && i == 2 ? Icons.close : (i < step ? Icons.check : i == step ? Icons.circle : null), size: failed && i == 2 ? 16 : (i < step ? 15 : 8), color: failed && i == 2 ? c.danger : (i <= step ? c.onAccent : c.borderStrong)),
              ),
              const SizedBox(height: 6),
              SizedBox(width: 92, child: Text(labels[i], textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: i == step ? c.text : c.muted, fontWeight: i == step ? FontWeight.w600 : FontWeight.w400), maxLines: 2)),
            ],
          ),
        ],
      ],
    );
  }
}

/// The fare breakdown of a trip, for the pay screen and history.
class ReceiptCard extends StatelessWidget {
  const ReceiptCard({super.key, required this.trip});
  final Trip trip;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final loc = context.localeTag;
    final c = context.colors;
    return SectionCard(
      title: l.receiptTitle,
      child: Column(
        children: [
          KeyValue(l.fareLabel, MoneyText(trip.fare.estimateMinor, locale: loc)),
          if ((trip.fare.waitingFeeMinor ?? 0) > 0) KeyValue(l.waitingFeeLabel, MoneyText(trip.fare.waitingFeeMinor, locale: loc)),
          if (trip.fare.promoDiscountMinor > 0) KeyValue(promoLabel(l, trip.fare), MoneyText(-trip.fare.promoDiscountMinor, locale: loc, style: TextStyle(color: c.success))),
          KeyValue(l.totalLabel, MoneyText(trip.fare.payableMinor, locale: loc, style: AnbessaType.title.copyWith(color: c.text))),
          KeyValue(l.paymentMethod, Text(paymentMethodLabel(l, trip.paymentMethod))),
          KeyValue(l.pickupLabel, Text(trip.pickup.address ?? '—')),
          KeyValue(l.dropoffLabel, Text(trip.dropoff.address ?? '—')),
          KeyValue(l.tripIdLabel, MonoText(shortId(trip.id))),
        ],
      ),
    );
  }
}
