// Choosing the ride (workflow 05 B–C): one card per vehicle type with its fixed price, the
// payment method, and Request. Quotes last 10 minutes; a new price is fetched when one expires.

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
    setState(() {
      _requesting = true;
      _error = null;
    });
    try {
      final trip = await ref.read(bookingProvider.notifier).request();
      if (mounted) context.go(Routes.riderTrip(trip.id));
    } on AppError catch (e) {
      if (e.code == ErrorCodes.activeTripExists) {
        await ref.read(activeTripProvider.notifier).refresh();
        final t = ref.read(activeTripProvider).value;
        if (t != null && mounted) context.go(Routes.riderTrip(t.id));
        return;
      }
      if (e.code == ErrorCodes.quoteExpired || e.code == ErrorCodes.invalidQuote) ref.read(bookingProvider.notifier).quote();
      setState(() => _error = e);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _requesting = false);
    }
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
    final paused = cfg.maintenance.newTripsPaused;
    final quote = b.quote;
    final expired = quote != null && quote.isExpired(_now);
    String nameOf(String code) => cfg.vehicleTypes.where((v) => v.code == code).firstOrNull?.name ?? code;
    final offered = [...methods.methods.where((m) => m != PaymentMethod.corporate), if (corporateOk) PaymentMethod.corporate];
    if (!offered.contains(b.paymentMethod) && offered.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => ref.read(bookingProvider.notifier).pay(offered.first));
    }

    return Scaffold(
      appBar: AppBar(title: Text(l.chooseRide)),
      body: Column(
        children: [
          SizedBox(
            height: 200,
            child: b.ready
                ? AnbessaMap(
                    fit: [LatLng(b.pickup!.lat, b.pickup!.lng), LatLng(b.dropoff!.lat, b.dropoff!.lng)],
                    pickup: LatLng(b.pickup!.lat, b.pickup!.lng),
                    dropoff: LatLng(b.dropoff!.lat, b.dropoff!.lng),
                    line: [LatLng(b.pickup!.lat, b.pickup!.lng), LatLng(b.dropoff!.lat, b.dropoff!.lng)],
                    interactive: false,
                  )
                : const SizedBox.shrink(),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _PlaceRow(icon: Icons.trip_origin, color: c.accent, text: b.pickup?.name ?? '—', onTap: () => context.push(Routes.riderPickup)),
                _PlaceRow(icon: Icons.stop, color: c.text, text: b.dropoff?.name ?? '—', onTap: () => context.push(Routes.riderDropoff)),
                const SizedBox(height: 12),
                if (b.quoting) const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Center(child: CircularProgressIndicator())),
                if (b.quoteError != null) Problem(b.quoteError, describe: (e) => describeError(l, e), onRetry: () => ref.read(bookingProvider.notifier).quote(), retryLabel: l.retry),
                if (!b.quoting && b.quoteError == null && b.quotes.isNotEmpty) ...[
                  if (quote?.approximate ?? false) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(l.estimateApproximate, tone: NoticeTone.info)),
                  for (final q in b.quotes)
                    _QuoteCard(
                      name: nameOf(q.vehicleType),
                      quote: q,
                      selected: q.vehicleType == b.vehicleType,
                      onTap: () => ref.read(bookingProvider.notifier).choose(q.vehicleType),
                    ),
                  const SizedBox(height: 8),
                  if (quote != null)
                    Text(expired ? l.quoteExpired : l.quoteExpiresIn(mmss(quote.expiresAt.difference(_now))), style: TextStyle(color: expired ? c.danger : c.muted, fontSize: 13)),
                  const SizedBox(height: 16),
                  Text(l.paymentMethod, style: TextStyle(color: c.muted, fontWeight: FontWeight.w600, fontSize: 12)),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final m in offered)
                        ChoiceChip(label: Text(paymentMethodLabel(l, m)), selected: b.paymentMethod == m, onSelected: (_) => ref.read(bookingProvider.notifier).pay(m, billingOrgId: m == PaymentMethod.corporate ? session?.claims.orgIds.first : null)),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (paused) Padding(padding: const EdgeInsets.only(bottom: 10), child: Notice(cfg.maintenance.message.isEmpty ? l.newTripsPaused : cfg.maintenance.message, tone: NoticeTone.warning)),
                  Problem(_error, describe: (e) => describeError(l, e)),
                  if (_error != null) const SizedBox(height: 10),
                  if (expired)
                    PrimaryButton(label: l.getNewQuote, icon: Icons.refresh, onPressed: () => ref.read(bookingProvider.notifier).quote())
                  else
                    PrimaryButton(label: '${l.requestRide(nameOf(quote?.vehicleType ?? ''))} · ${birr(quote?.fareMinor, locale: context.localeTag)}', busy: _requesting, onPressed: paused || quote == null ? null : _request),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PlaceRow extends StatelessWidget {
  const _PlaceRow({required this.icon, required this.color, required this.text, required this.onTap});
  final IconData icon;
  final Color color;
  final String text;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon, size: 18, color: color),
        title: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis),
        trailing: const Icon(Icons.edit_outlined, size: 18),
        onTap: onTap,
      );
}

class _QuoteCard extends StatelessWidget {
  const _QuoteCard({required this.name, required this.quote, required this.selected, required this.onTap});
  final String name;
  final Quote quote;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        borderRadius: BorderRadius.circular(anbessaRadiusLg),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: selected ? c.accentSoft : c.surface,
            borderRadius: BorderRadius.circular(anbessaRadiusLg),
            border: Border.all(color: selected ? c.accent : c.border, width: selected ? 2 : 1),
          ),
          child: Row(
            children: [
              Icon(quote.vehicleType == 'minivan' ? Icons.airport_shuttle : Icons.directions_car, size: 32, color: selected ? c.accentStrong : c.text2),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                    Text(l.distanceTime(km(quote.distanceMeters), minutesOf(quote.durationSeconds)), style: TextStyle(color: c.muted, fontSize: 13)),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  MoneyText(quote.fareMinor, locale: context.localeTag, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  Text(l.fareFixed, style: TextStyle(color: c.muted, fontSize: 11)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
