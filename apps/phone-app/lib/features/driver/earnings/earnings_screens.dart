// Earnings (workflow 09): what the driver made today / this week / this month, where the fare
// went, the balance and its state, limits and dues; top-ups by mobile money (the provider's
// page, then `balance:topped_up`); the payout method; the statement and the list of top-ups.
// Incentive programs ("complete N trips, earn X") show with the driver's progress.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../bootstrap/gates.dart' show AnbessaLogo;
import '../../config/client_config_provider.dart';
import '../../rider/booking/booking_controller.dart';
import 'earnings_chart.dart';
import 'earnings_controller.dart';
import 'earnings_summary_controller.dart';

Tone balanceTone(BalanceState s) => switch (s) {
  BalanceState.ok => Tone.green,
  BalanceState.warning => Tone.amber,
  _ => Tone.red,
};

String balanceStateLabel(AppLocalizations l, BalanceState s) => switch (s) {
  BalanceState.ok => l.ok,
  BalanceState.warning => l.balanceWarningLede.split(':').first,
  BalanceState.cashBlocked => l.balanceCashBlockedLede.split('.').first,
  BalanceState.blocked => l.balanceBlockedLede.split('.').first,
  BalanceState.unknown => '—',
};

class EarningsScreen extends ConsumerStatefulWidget {
  const EarningsScreen({super.key});
  @override
  ConsumerState<EarningsScreen> createState() => _EarningsScreenState();
}

class _EarningsScreenState extends ConsumerState<EarningsScreen> {
  String _period = 'today';

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final bAsync = ref.watch(balanceProvider);
    final b = bAsync.value;
    final sAsync = ref.watch(earningsSummaryProvider(_period));
    final s = sAsync.value;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(
        title: l.earningsTitle,
        leadingKind: TopBarLeading.none,
        leading: const Padding(
          padding: EdgeInsetsDirectional.only(start: AnbessaSpace.page),
          child: Align(alignment: AlignmentDirectional.centerStart, child: AnbessaLogo(size: 30)),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          await ref.read(balanceProvider.notifier).refresh();
          await ref.read(earningsSummaryProvider(_period).notifier).refresh();
          ref.invalidate(incentivesProvider);
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 32),
          children: [
            SegmentedTabs<String>(items: [('today', l.periodToday), ('week', l.periodWeek), ('month', l.periodMonth)], selected: _period, onChanged: (v) => setState(() => _period = v)),
            const SizedBox(height: 16),
            // the hero: what's left after commission and VAT, big and centred, the days below
            AppCard(
              padding: const EdgeInsets.fromLTRB(16, 20, 16, 16),
              child: sAsync.isLoading && s == null
                  ? const Column(
                      children: [Skeleton.line(width: 90, height: 12), SizedBox(height: 10), Skeleton.line(width: 160, height: 28), SizedBox(height: 14), Skeleton.box(height: 110, radius: 8)],
                    )
                  : sAsync.hasError && s == null
                  ? Problem(sAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(earningsSummaryProvider(_period).notifier).refresh(), retryLabel: l.retry)
                  : Column(
                      children: [
                        Text(l.netEarnings, style: AnbessaType.body2.copyWith(color: c.muted)),
                        const SizedBox(height: 6),
                        FittedBox(
                          fit: BoxFit.scaleDown,
                          child: AnimatedMoney(
                            s!.netMinor,
                            locale: loc,
                            style: AnbessaType.display.copyWith(fontSize: 32, color: s.netMinor < 0 ? c.danger : c.text),
                          ),
                        ),
                        if (s.byDay.length > 1) ...[const SizedBox(height: 16), EarningsChart(days: s.byDay)],
                        if (s.trips == 0)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              l.noEarningsPeriod,
                              textAlign: TextAlign.center,
                              style: AnbessaType.caption.copyWith(color: c.muted),
                            ),
                          ),
                      ],
                    ),
            ),
            if (s != null) ...[
              const SizedBox(height: 12),
              StatTriple(
                items: [
                  StatTriple.item(Icons.route_outlined, '${s.trips}', l.tripsToday),
                  StatTriple.item(Icons.receipt_long_outlined, birr(s.grossMinor, locale: loc), l.grossFares),
                  StatTriple.item(Icons.payments_outlined, birr(s.cashCollectedMinor, locale: loc), l.cashCollected),
                ],
              ),
            ],
            if (s != null && s.trips > 0) ...[
              const SizedBox(height: 20),
              _SectionTitle(l.earningsBreakdown),
              KeyValueCard(
                rows: [
                  KeyValueCard.row(l.grossFares, birr(s.grossMinor, locale: loc)),
                  KeyValueCard.row(l.commissionLabel, birr(-s.commissionMinor, locale: loc), valueColor: c.danger),
                  KeyValueCard.row(l.vatLabel, birr(-s.vatMinor, locale: loc), valueColor: c.danger),
                ],
                total: KeyValueCard.row(l.netEarnings, birr(s.netMinor, locale: loc)),
              ),
            ],
            const _Incentives(),
            const SizedBox(height: 20),
            // the balance
            if (bAsync.hasError && b == null) Problem(bAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(balanceProvider.notifier).refresh(), retryLabel: l.retry),
            if (b == null && !bAsync.hasError) const SkeletonCard(height: 160),
            if (b != null) ...[
              _SectionTitle(l.balanceCard, trailing: StatusPill(balanceStateLabel(l, b.state), tone: balanceTone(b.state))),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      b.balanceMinor == 0
                          ? l.balanceZero
                          : b.owes
                          ? l.youOwe(birr(-b.balanceMinor, locale: loc))
                          : l.weOweYou(birr(b.balanceMinor, locale: loc)),
                      style: AnbessaType.h1.copyWith(color: b.owes ? c.danger : c.text, fontFeatures: AnbessaType.tabular),
                    ),
                    const SizedBox(height: 4),
                    Text(switch (b.state) {
                      BalanceState.ok => l.balanceOkLede,
                      BalanceState.warning => l.balanceWarningLede,
                      BalanceState.cashBlocked => l.balanceCashBlockedLede,
                      BalanceState.blocked => l.balanceBlockedLede,
                      BalanceState.unknown => '',
                    }, style: AnbessaType.body2.copyWith(color: c.text2)),
                    const SizedBox(height: 8),
                    Text(
                      b.policy.prepaid
                          ? l.prepaidLine(birr(b.policy.prepaidMinimumMinor, locale: loc))
                          : l.limitsLine(birr(b.policy.warningMinor, locale: loc), birr(b.policy.cashLimitMinor, locale: loc), birr(b.policy.hardLimitMinor, locale: loc)),
                      style: AnbessaType.caption.copyWith(color: c.muted),
                    ),
                    for (final d in b.openDues) ...[
                      const SizedBox(height: 10),
                      Notice(
                        '${d.status == 'OVERDUE' ? '${l.paymentOverdue}: ' : ''}${l.paymentDueLine(birr(d.minimumLeftMinor, locale: loc), dayOf(d.dueAt, locale: loc))}',
                        tone: d.status == 'OVERDUE' ? NoticeTone.error : NoticeTone.warning,
                      ),
                    ],
                    const SizedBox(height: 16),
                    PillButtonPair(
                      first: PillButton(label: l.statement, variant: PillVariant.outlineNeutral, onPressed: b.accountId == null ? null : () => context.push(Routes.driverStatement)),
                      second: PillButton(label: l.topUp, icon: Icons.add_rounded, onPressed: () => context.push(Routes.driverTopUp)),
                    ),
                    if (b.suggestedTopUpMinor > 0)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Text(
                          l.suggestedTopUp(birr(b.suggestedTopUpMinor, locale: loc)),
                          textAlign: TextAlign.center,
                          style: AnbessaType.caption.copyWith(color: c.muted),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              AppCard(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Column(
                  children: [
                    ListRowTile(
                      icon: Icons.account_balance_outlined,
                      title: l.payoutMethod,
                      subtitle: b.payoutMethod == null ? l.noPayoutMethod : '${providerLabel(b.payoutMethod!.provider)} ${b.payoutMethod!.destination ?? ''}',
                      titleColor: b.payoutMethod == null ? c.warning : null,
                      chevron: b.accountId != null,
                      divider: b.referenceCode != null || b.accountId != null,
                      onTap: b.accountId == null ? null : () => context.push(Routes.driverPayoutMethod),
                    ),
                    if (b.referenceCode != null)
                      ListRowTile(
                        icon: Icons.tag_rounded,
                        title: l.referenceCode,
                        subtitle: l.referenceCodeHint,
                        divider: b.accountId != null,
                        value: b.referenceCode!,
                      ),
                    if (b.accountId != null) ListRowTile(icon: Icons.history_rounded, title: l.topUps, chevron: true, onTap: () => context.push(Routes.driverTopUps)),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  l.payoutsWeekly(birr(b.policy.minPayoutMinor, locale: loc)),
                  style: AnbessaType.caption.copyWith(color: c.muted),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A bold section title above a card, with something on the right (a status pill).
class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text, {this.trailing});
  final String text;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      children: [
        Expanded(
          flex: 2,
          child: Text(text, style: AnbessaType.title.copyWith(color: context.colors.text)),
        ),
        if (trailing != null) Flexible(flex: 3, child: FittedBox(fit: BoxFit.scaleDown, alignment: AlignmentDirectional.centerEnd, child: trailing)),
      ],
    ),
  );
}

class TopUpScreen extends ConsumerStatefulWidget {
  const TopUpScreen({super.key});
  @override
  ConsumerState<TopUpScreen> createState() => _TopUpScreenState();
}

class _TopUpScreenState extends ConsumerState<TopUpScreen> {
  late final _amount = TextEditingController(
    text: ((ref.read(balanceProvider).value?.suggestedTopUpMinor ?? 0) > 0) ? ((ref.read(balanceProvider).value!.suggestedTopUpMinor) / 100).toStringAsFixed(0) : '',
  );
  String? _provider;
  bool _busy = false;
  Object? _error;
  TopUp? _started;
  Timer? _poll;
  late final String _key = newIdempotencyKey();

  @override
  void dispose() {
    _poll?.cancel();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _pay(String provider) async {
    final minor = toMinor(_amount.text);
    if (minor == null) return;
    Haptics.medium();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      var b = ref.read(balanceProvider).value;
      if (b?.accountId == null) b = await ref.read(balanceProvider.notifier).open();
      final t = await ref.read(apisProvider).payments.createTopUp(b!.accountId!, amountMinor: minor, provider: provider, idempotencyKey: _key);
      setState(() => _started = t);
      if (t.checkoutUrl != null) await launchUrl(Uri.parse(t.checkoutUrl!), mode: LaunchMode.inAppBrowserView);
      _poll = Timer.periodic(const Duration(seconds: 5), (_) async {
        final u = await ref.read(apisProvider).payments.topUp(t.id);
        if (!mounted) return;
        setState(() => _started = u);
        if (!u.isOpen) {
          _poll?.cancel();
          if (u.status == TopUpStatus.succeeded) Haptics.success();
          ref.read(balanceProvider.notifier).refresh();
        }
      });
    } catch (e) {
      Haptics.error();
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final methods = ref.watch(paymentMethodsProvider).value ?? PaymentMethodsConfig.fallback;
    final providers = methods.providers.where((p) => p.takesMobileMoney).toList();
    final provider = _provider ?? providers.firstOrNull?.provider;
    final minor = toMinor(_amount.text);
    final started = _started;
    final suggested = ref.watch(balanceProvider).value?.suggestedTopUpMinor ?? 0;
    final chips = {if (suggested > 0) suggested, 50000, 100000, 200000, 500000}.toList()..sort();
    final balance = ref.watch(balanceProvider).value;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.topUpTitle),
      bottomNavigationBar: started != null
          ? BottomActionBar(
              child: PillButton(label: l.done, onPressed: () => context.pop()),
            )
          : BottomActionBar(
              child: PillButton(
                label: minor == null ? l.topUp : l.payTopUp(birr(minor, locale: loc)),
                busy: _busy,
                onPressed: minor == null || provider == null ? null : () => _pay(provider),
              ),
            ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          if (started != null) ...[
            if (started.status == TopUpStatus.succeeded) ...[
              const SizedBox(height: 32),
              const Center(child: ResultBadge()),
              const SizedBox(height: 20),
              Text(
                l.topUpCredited(birr(started.amountMinor, locale: loc)),
                textAlign: TextAlign.center,
                style: AnbessaType.h2.copyWith(color: c.text),
              ),
            ] else if (started.status == TopUpStatus.failed) ...[
              const SizedBox(height: 32),
              const Center(child: ResultBadge(icon: Icons.close_rounded, danger: true)),
              const SizedBox(height: 20),
              Text(
                l.actWhoops,
                textAlign: TextAlign.center,
                style: AnbessaType.h2.copyWith(color: c.text),
              ),
              const SizedBox(height: 8),
              Text(
                started.failure ?? l.paymentFailed,
                textAlign: TextAlign.center,
                style: AnbessaType.body2.copyWith(color: c.text2),
              ),
            ] else
              Column(
                children: [
                  const SizedBox(height: 16),
                  const LinearProgressIndicator(),
                  const SizedBox(height: 16),
                  Notice(started.instructions ?? l.topUpStarted(providerLabel(started.provider ?? '')), tone: NoticeTone.info),
                ],
              ),
            const SizedBox(height: 16),
            if (started.isOpen && started.checkoutUrl != null)
              PillButton(
                label: l.openPaymentPage,
                variant: PillVariant.outline,
                onPressed: () => launchUrl(Uri.parse(started.checkoutUrl!), mode: LaunchMode.inAppBrowserView),
              ),
          ] else ...[
            // the amount, big and centred in a card (the kit's "Top Up")
            AppCard(
              padding: const EdgeInsets.fromLTRB(16, 20, 16, 16),
              child: Column(
                children: [
                  TextField(
                    controller: _amount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    textAlign: TextAlign.center,
                    style: AnbessaType.display.copyWith(fontSize: 36, color: c.text, fontFeatures: AnbessaType.tabular),
                    decoration: InputDecoration(
                      hintText: '0',
                      hintStyle: AnbessaType.display.copyWith(fontSize: 36, color: c.faint),
                      filled: false,
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      suffixText: 'ETB',
                      semanticCounterText: l.topUpAmount,
                      contentPadding: EdgeInsets.zero,
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                  if (balance != null) ...[
                    const SizedBox(height: 6),
                    Text(
                      l.drv2AvailableBalance(birr(balance.balanceMinor, locale: loc)),
                      style: AnbessaType.caption.copyWith(color: c.muted),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 10,
              alignment: WrapAlignment.center,
              children: [
                for (final a in chips)
                  OutlineChip(
                    label: birr(a, locale: loc),
                    selected: minor == a,
                    onTap: () {
                      Haptics.selection();
                      setState(() => _amount.text = (a / 100).toStringAsFixed(0));
                    },
                  ),
              ],
            ),
            const SizedBox(height: 24),
            Text(l.drv2ChooseMethod, style: AnbessaType.title.copyWith(color: c.text)),
            const SizedBox(height: 10),
            for (final p in providers)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SelectableCard(
                  selected: provider == p.provider,
                  onTap: () => setState(() => _provider = p.provider),
                  child: Row(
                    children: [
                      ExcludeSemantics(child: CircleIcon(Icons.account_balance_wallet_outlined, color: c.accentText)),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(p.label, style: AnbessaType.title.copyWith(color: c.text)),
                            if (p.isSimulated) Text(l.simulatedProvider, style: AnbessaType.caption.copyWith(color: c.muted)),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            Problem(_error, describe: (e) => describeError(l, e)),
          ],
        ],
      ),
    );
  }
}

class PayoutMethodScreen extends ConsumerStatefulWidget {
  const PayoutMethodScreen({super.key});
  @override
  ConsumerState<PayoutMethodScreen> createState() => _PayoutMethodScreenState();
}

class _PayoutMethodScreenState extends ConsumerState<PayoutMethodScreen> {
  late String _provider = ref.read(balanceProvider).value?.payoutMethod?.provider ?? 'telebirr';
  final _dest = TextEditingController();
  bool _busy = false;
  Object? _error;

  Future<void> _save() async {
    final b = ref.read(balanceProvider).value;
    if (b?.accountId == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apisProvider).payments.setPayoutMethod(b!.accountId!, provider: _provider, destination: _dest.text.trim());
      await ref.read(balanceProvider.notifier).refresh();
      Haptics.success();
      if (mounted) context.pop();
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
    final ok = _dest.text.replaceAll(RegExp(r'\D'), '').length >= 6;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.payoutMethod),
      bottomNavigationBar: BottomActionBar(
        child: PillButton(label: l.savePayoutMethod, busy: _busy, onPressed: ok ? _save : null),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 24),
        children: [
          Text(l.payoutMethodLede, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 16),
          for (final (code, name) in const [('telebirr', 'telebirr'), ('cbebirr', 'CBE Birr'), ('chapa', 'Bank account (Chapa)')])
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: SelectableCard(
                selected: _provider == code,
                onTap: () => setState(() => _provider = code),
                child: Row(
                  children: [
                    ExcludeSemantics(child: CircleIcon(code == 'chapa' ? Icons.account_balance_outlined : Icons.phone_iphone_rounded, color: c.accentText)),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Text(name, style: AnbessaType.title.copyWith(color: c.text)),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 12),
          FilledField(
            label: l.payoutDestination,
            controller: _dest,
            keyboardType: TextInputType.phone,
            hint: _provider == 'chapa' ? '1000123456789' : '+251 911 22 33 44',
            icon: code(_provider),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),
          Problem(_error, describe: (e) => describeError(l, e)),
        ],
      ),
    );
  }

  static IconData code(String provider) => provider == 'chapa' ? Icons.numbers_rounded : Icons.phone_outlined;
}

class StatementScreen extends ConsumerStatefulWidget {
  const StatementScreen({super.key});
  @override
  ConsumerState<StatementScreen> createState() => _StatementScreenState();
}

class _StatementScreenState extends ConsumerState<StatementScreen> {
  List<StatementEntry> _entries = const [];
  String? _next;
  bool _loading = true;
  Object? _error;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _load();
    _scroll.addListener(() {
      if (_scroll.position.extentAfter < 300 && _next != null && !_loading) _load(more: true);
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load({bool more = false}) async {
    final b = ref.read(balanceProvider).value;
    if (b?.accountId == null) return setState(() => _loading = false);
    setState(() => _loading = true);
    try {
      final page = await ref.read(apisProvider).payments.statement(b!.accountId!, before: more ? _next : null);
      setState(() {
        _entries = more ? [..._entries, ...page.entries] : page.entries;
        _next = page.next;
        _error = null;
      });
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  IconData _icon(String kind) => switch (kind) {
    'TRIP_SETTLEMENT' => Icons.directions_car_rounded,
    'TOP_UP' => Icons.add_card_rounded,
    'PAYOUT' => Icons.account_balance_rounded,
    'REFUND' => Icons.undo_rounded,
    'CANCELLATION_FEE' => Icons.close_rounded,
    _ => Icons.receipt_long_rounded,
  };

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.statement),
      body: _loading && _entries.isEmpty
          ? const Padding(padding: EdgeInsets.all(AnbessaSpace.page), child: SkeletonList(rows: 6))
          : ListView(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 0, AnbessaSpace.page, 24),
              children: [
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Problem(_error, describe: (e) => describeError(l, e), onRetry: _load, retryLabel: l.retry),
                  ),
                if (_entries.isEmpty && _error == null)
                  Padding(
                    padding: const EdgeInsets.only(top: 40),
                    child: IllustratedEmpty(illustration: AnbessaIllustration.wallet, title: l.statementEmpty),
                  ),
                // rows like Activity's: the kind in a circle, when, the signed amount
                for (final (i, e) in _entries.indexed)
                  ListRowTile(
                    leading: ExcludeSemantics(child: CircleIcon(_icon(e.kind), color: e.amountMinor < 0 ? c.danger : c.accentText)),
                    title: statementKindLabel(l, e.kind),
                    subtitle: '${dayOf(e.at, locale: loc)} · ${clockOf(e.at)}${e.memo != null ? ' · ${e.memo}' : ''}',
                    value: '${e.amountMinor > 0 ? '+' : ''}${birr(e.amountMinor, locale: loc)}',
                    divider: i < _entries.length - 1,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                  ),
                if (_next != null)
                  const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
                  ),
              ],
            ),
    );
  }
}

class TopUpsScreen extends ConsumerWidget {
  const TopUpsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final b = ref.watch(balanceProvider).value;
    final loc = context.localeTag;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.topUps),
      body: b?.accountId == null
          ? IllustratedEmpty(illustration: AnbessaIllustration.wallet, title: l.statementEmpty)
          : FutureBuilder(
              future: ref.read(apisProvider).payments.topUps(b!.accountId!),
              builder: (context, snap) {
                if (snap.hasError) {
                  return Padding(
                    padding: const EdgeInsets.all(AnbessaSpace.page),
                    child: Problem(snap.error, describe: (e) => describeError(l, e)),
                  );
                }
                final list = snap.data;
                if (list == null) return const Padding(padding: EdgeInsets.all(AnbessaSpace.page), child: SkeletonList(rows: 4));
                if (list.isEmpty) return IllustratedEmpty(illustration: AnbessaIllustration.wallet, title: l.statementEmpty);
                // the kit's Top Up rows: + in a circle, when, the amount with the method under it
                return ListView(
                  padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 0, AnbessaSpace.page, 24),
                  children: [
                    for (final (i, t) in list.indexed)
                      ListRowTile(
                        leading: ExcludeSemantics(child: CircleIcon(Icons.add_rounded, color: c.accentText)),
                        title:
                            '${t.channel == 'MOBILE_MONEY'
                                ? l.mobileMoney
                                : t.channel == 'OFFICE_CASH'
                                ? l.cash
                                : 'Bank'}${t.provider != null && t.provider != 'bank' ? ' · ${providerLabel(t.provider!)}' : ''}',
                        subtitle: '${dayOf(t.createdAt, locale: loc)} · ${clockOf(t.createdAt)}',
                        value: birr(t.amountMinor, locale: loc),
                        valueSub: t.status.name,
                        valueSubColor: t.status == TopUpStatus.succeeded
                            ? c.success
                            : t.isOpen
                            ? c.warning
                            : c.danger,
                        divider: i < list.length - 1,
                        padding: const EdgeInsets.symmetric(vertical: 14),
                      ),
                  ],
                );
              },
            ),
    );
  }
}

/// Running, upcoming and recently closed incentive programs; nothing when there are none or they
/// can't be loaded (the rest of the screen matters more).
class _Incentives extends ConsumerWidget {
  const _Incentives();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final list = ref.watch(incentivesProvider).value ?? const <Incentive>[];
    if (list.isEmpty) return const SizedBox.shrink();
    final now = DateTime.now().toUtc();
    final types = ref.watch(configProvider).vehicleTypes;
    return Padding(
      padding: const EdgeInsets.only(top: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _SectionTitle(l.incentivesTitle),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final i in list)
                  Padding(
                    key: ValueKey(i.id),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(i.name, style: AnbessaType.title.copyWith(color: c.text)),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              l.incentiveReward(birr(i.rewardMinor, locale: loc)),
                              style: AnbessaType.body2.copyWith(color: c.accentText, fontWeight: FontWeight.w700, fontFeatures: AnbessaType.tabular),
                            ),
                          ],
                        ),
                        if (i.vehicleType != null)
                          Text(l.incentiveVehicle(types.where((v) => v.code == i.vehicleType).firstOrNull?.name ?? i.vehicleType!), style: AnbessaType.caption.copyWith(color: c.muted)),
                        const SizedBox(height: 8),
                        ProgressMeter(value: i.progress, semanticsLabel: l.incentiveProgress(i.trips, i.targetTrips)),
                        const SizedBox(height: 6),
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                l.incentiveProgress(i.trips, i.targetTrips),
                                style: AnbessaType.caption.copyWith(color: c.text2, fontFeatures: AnbessaType.tabular),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                i.closed
                                    ? (i.awardedMinor > 0 ? l.incentiveEarned(birr(i.awardedMinor, locale: loc)) : l.incentiveMissed)
                                    : i.counting(now)
                                    ? l.incentiveCounting
                                    : i.startsLater(now)
                                    ? l.incentiveStarts(dayAndTime(i.startsAt, locale: loc))
                                    : l.incentiveEnds(dayAndTime(i.endsAt, locale: loc)),
                                textAlign: TextAlign.end,
                                style: AnbessaType.caption.copyWith(color: i.closed && i.awardedMinor > 0 ? c.success : c.muted),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(l.incentivesLede, style: AnbessaType.caption.copyWith(color: c.muted)),
          ),
        ],
      ),
    );
  }
}
