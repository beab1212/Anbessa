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
import '../../config/client_config_provider.dart';
import '../../rider/booking/booking_controller.dart';
import 'earnings_chart.dart';
import 'earnings_controller.dart';
import 'earnings_summary_controller.dart';

Tone balanceTone(BalanceState s) => switch (s) { BalanceState.ok => Tone.green, BalanceState.warning => Tone.amber, _ => Tone.red };

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
      body: RefreshIndicator(
        onRefresh: () async {
          await ref.read(balanceProvider.notifier).refresh();
          await ref.read(earningsSummaryProvider(_period).notifier).refresh();
          ref.invalidate(incentivesProvider);
        },
        child: CustomScrollView(
          slivers: [
            SliverAppBar(pinned: true, title: Text(l.earningsTitle)),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
              sliver: SliverList.list(
                children: [
                  PillTabs<String>(items: [('today', l.periodToday), ('week', l.periodWeek), ('month', l.periodMonth)], selected: _period, onChanged: (v) => setState(() => _period = v)),
                  const SizedBox(height: 14),
                  // the hero
                  FloatingCard(
                    radius: AnbessaRadius.lg,
                    child: sAsync.isLoading && s == null
                        ? const Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Skeleton.line(width: 90, height: 12), SizedBox(height: 10), Skeleton.line(width: 160, height: 28), SizedBox(height: 14), Skeleton.box(height: 110, radius: 8)])
                        : sAsync.hasError && s == null
                            ? Problem(sAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(earningsSummaryProvider(_period).notifier).refresh(), retryLabel: l.retry)
                            : Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(l.netEarnings, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4)),
                                  const SizedBox(height: 4),
                                  AnimatedMoney(s!.netMinor, locale: loc, style: AnbessaType.display.copyWith(color: s.netMinor < 0 ? c.danger : c.text)),
                                  const SizedBox(height: 12),
                                  StatRow(
                                    children: [
                                      StatTile(label: l.tripsToday, icon: Icons.route_outlined, value: AnimatedCounter(value: s.trips, format: (v) => v.round().toString())),
                                      StatTile(label: l.grossFares, icon: Icons.receipt_long_outlined, value: AnimatedMoney(s.grossMinor, locale: loc)),
                                      StatTile(label: l.cashCollected, icon: Icons.payments_outlined, value: AnimatedMoney(s.cashCollectedMinor, locale: loc)),
                                    ],
                                  ),
                                  if (s.byDay.length > 1) ...[const SizedBox(height: 16), EarningsChart(days: s.byDay)],
                                  if (s.trips == 0) Padding(padding: const EdgeInsets.only(top: 12), child: Text(l.noEarningsPeriod, style: AnbessaType.caption.copyWith(color: c.muted))),
                                ],
                              ),
                  ),
                  if (s != null && s.trips > 0) ...[
                    const SizedBox(height: 14),
                    SectionGroup(
                      title: l.earningsBreakdown,
                      margin: EdgeInsets.zero,
                      children: [
                        _MoneyRow(l.grossFares, s.grossMinor),
                        _MoneyRow(l.commissionLabel, -s.commissionMinor),
                        _MoneyRow(l.vatLabel, -s.vatMinor),
                        _MoneyRow(l.netEarnings, s.netMinor, strong: true),
                      ],
                    ),
                  ],
                  const _Incentives(),
                  const SizedBox(height: 18),
                  // the balance
                  if (bAsync.hasError && b == null) Problem(bAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(balanceProvider.notifier).refresh(), retryLabel: l.retry),
                  if (b == null && !bAsync.hasError) const SkeletonCard(height: 160),
                  if (b != null) ...[
                    SectionCard(
                      title: l.balanceCard,
                      trailing: StatusPill(balanceStateLabel(l, b.state), tone: balanceTone(b.state)),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(b.balanceMinor == 0 ? l.balanceZero : b.owes ? l.youOwe(birr(-b.balanceMinor, locale: loc)) : l.weOweYou(birr(b.balanceMinor, locale: loc)), style: AnbessaType.h1.copyWith(color: b.owes ? c.danger : c.text, fontFeatures: AnbessaType.tabular)),
                          const SizedBox(height: 4),
                          Text(
                            switch (b.state) {
                              BalanceState.ok => l.balanceOkLede,
                              BalanceState.warning => l.balanceWarningLede,
                              BalanceState.cashBlocked => l.balanceCashBlockedLede,
                              BalanceState.blocked => l.balanceBlockedLede,
                              BalanceState.unknown => '',
                            },
                            style: AnbessaType.body2.copyWith(color: c.text2),
                          ),
                          const SizedBox(height: 10),
                          Text(
                            b.policy.prepaid ? l.prepaidLine(birr(b.policy.prepaidMinimumMinor, locale: loc)) : l.limitsLine(birr(b.policy.warningMinor, locale: loc), birr(b.policy.cashLimitMinor, locale: loc), birr(b.policy.hardLimitMinor, locale: loc)),
                            style: AnbessaType.caption.copyWith(color: c.muted),
                          ),
                          for (final d in b.openDues) ...[
                            const SizedBox(height: 10),
                            Notice('${d.status == 'OVERDUE' ? '${l.paymentOverdue}: ' : ''}${l.paymentDueLine(birr(d.minimumLeftMinor, locale: loc), dayOf(d.dueAt, locale: loc))}', tone: d.status == 'OVERDUE' ? NoticeTone.error : NoticeTone.warning),
                          ],
                          const SizedBox(height: 14),
                          Row(
                            children: [
                              Expanded(child: PrimaryButton(label: l.topUp, icon: Icons.add, onPressed: () => context.push(Routes.driverTopUp))),
                              const SizedBox(width: 8),
                              Expanded(child: OutlinedButton(onPressed: b.accountId == null ? null : () => context.push(Routes.driverStatement), child: Text(l.statement))),
                            ],
                          ),
                          if (b.suggestedTopUpMinor > 0) Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.suggestedTopUp(birr(b.suggestedTopUpMinor, locale: loc)), style: AnbessaType.caption.copyWith(color: c.muted))),
                        ],
                      ),
                    ),
                    const SizedBox(height: 14),
                    SectionGroup(
                      margin: EdgeInsets.zero,
                      children: [
                        SettingsTile(
                          icon: Icons.account_balance_outlined,
                          title: l.payoutMethod,
                          subtitle: b.payoutMethod == null ? l.noPayoutMethod : '${providerLabel(b.payoutMethod!.provider)} ${b.payoutMethod!.destination ?? ''}',
                          iconTone: b.payoutMethod == null ? c.warning : null,
                          onTap: b.accountId == null ? null : () => context.push(Routes.driverPayoutMethod),
                        ),
                        if (b.referenceCode != null)
                          SettingsTile(
                            icon: Icons.tag,
                            title: l.referenceCode,
                            subtitle: l.referenceCodeHint,
                            chevron: false,
                            trailing: MonoText(b.referenceCode!, style: AnbessaType.title.copyWith(color: c.text, letterSpacing: 1.5)),
                          ),
                        if (b.accountId != null) SettingsTile(icon: Icons.history, title: l.topUps, onTap: () => context.push(Routes.driverTopUps)),
                      ],
                    ),
                    Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.payoutsWeekly(birr(b.policy.minPayoutMinor, locale: loc)), style: AnbessaType.caption.copyWith(color: c.muted))),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MoneyRow extends StatelessWidget {
  const _MoneyRow(this.label, this.minor, {this.strong = false});
  final String label;
  final int minor;
  final bool strong;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          Expanded(child: Text(label, style: (strong ? AnbessaType.body.copyWith(fontWeight: FontWeight.w700) : AnbessaType.body2).copyWith(color: strong ? c.text : c.text2))),
          MoneyText(minor, locale: context.localeTag, signed: !strong && minor > 0, style: (strong ? AnbessaType.title : AnbessaType.body2).copyWith(color: minor < 0 && !strong ? c.danger : c.text)),
        ],
      ),
    );
  }
}

class TopUpScreen extends ConsumerStatefulWidget {
  const TopUpScreen({super.key});
  @override
  ConsumerState<TopUpScreen> createState() => _TopUpScreenState();
}

class _TopUpScreenState extends ConsumerState<TopUpScreen> {
  late final _amount = TextEditingController(text: ((ref.read(balanceProvider).value?.suggestedTopUpMinor ?? 0) > 0) ? ((ref.read(balanceProvider).value!.suggestedTopUpMinor) / 100).toStringAsFixed(0) : '');
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
    return Scaffold(
      appBar: AppBar(title: Text(l.topUpTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (started != null) ...[
            if (started.status == TopUpStatus.succeeded)
              IllustratedEmpty(illustration: AnbessaIllustration.celebrate, title: l.topUpCredited(birr(started.amountMinor, locale: loc)), compact: true)
            else if (started.status == TopUpStatus.failed)
              Notice(started.failure ?? l.paymentFailed, tone: NoticeTone.error)
            else
              Column(children: [const LinearProgressIndicator(), const SizedBox(height: 12), Notice(started.instructions ?? l.topUpStarted(providerLabel(started.provider ?? '')), tone: NoticeTone.info)]),
            const SizedBox(height: 12),
            if (started.isOpen && started.checkoutUrl != null) OutlinedButton(onPressed: () => launchUrl(Uri.parse(started.checkoutUrl!), mode: LaunchMode.inAppBrowserView), child: Text(l.openPaymentPage)),
            const SizedBox(height: 8),
            PrimaryButton(label: l.done, onPressed: () => context.pop()),
          ] else ...[
            TextField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              style: AnbessaType.h1.copyWith(fontFeatures: AnbessaType.tabular),
              decoration: InputDecoration(labelText: l.topUpAmount, prefixText: 'ETB '),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final a in chips)
                  ChoiceChip(
                    label: Text(birr(a, locale: loc)),
                    selected: minor == a,
                    onSelected: (_) {
                      Haptics.selection();
                      setState(() => _amount.text = (a / 100).toStringAsFixed(0));
                    },
                  ),
              ],
            ),
            const SizedBox(height: 18),
            Text(l.topUpProvider, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4)),
            const SizedBox(height: 8),
            SectionGroup(
              margin: EdgeInsets.zero,
              children: [
                for (final p in providers)
                  ChoiceRow(title: p.label, subtitle: p.isSimulated ? l.simulatedProvider : null, leading: Icon(Icons.account_balance_wallet_outlined, color: c.accentStrong), selected: provider == p.provider, onTap: () => setState(() => _provider = p.provider)),
              ],
            ),
            const SizedBox(height: 12),
            Problem(_error, describe: (e) => describeError(l, e)),
            const SizedBox(height: 8),
            PrimaryButton(label: minor == null ? l.topUp : l.payTopUp(birr(minor, locale: loc)), busy: _busy, onPressed: minor == null || provider == null ? null : () => _pay(provider)),
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
    return Scaffold(
      appBar: AppBar(title: Text(l.payoutMethod)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(l.payoutMethodLede, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 14),
          SectionGroup(
            margin: EdgeInsets.zero,
            children: [
              for (final (code, name) in const [('telebirr', 'telebirr'), ('cbebirr', 'CBE Birr'), ('chapa', 'Bank account (Chapa)')])
                ChoiceRow(title: name, leading: Icon(code == 'chapa' ? Icons.account_balance_outlined : Icons.phone_iphone, color: c.accentStrong), selected: _provider == code, onTap: () => setState(() => _provider = code)),
            ],
          ),
          const SizedBox(height: 14),
          TextField(controller: _dest, keyboardType: TextInputType.phone, decoration: InputDecoration(labelText: l.payoutDestination, hintText: _provider == 'chapa' ? '1000123456789' : '+251 911 22 33 44'), onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          PrimaryButton(label: l.savePayoutMethod, busy: _busy, onPressed: _dest.text.replaceAll(RegExp(r'\D'), '').length < 6 ? null : _save),
        ],
      ),
    );
  }
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
        'TRIP_SETTLEMENT' => Icons.directions_car_outlined,
        'TOP_UP' => Icons.add_card_outlined,
        'PAYOUT' => Icons.account_balance_outlined,
        'REFUND' => Icons.undo,
        'CANCELLATION_FEE' => Icons.close_rounded,
        _ => Icons.receipt_long_outlined,
      };

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final groups = <String, List<StatementEntry>>{};
    for (final e in _entries) {
      groups.putIfAbsent(dayOf(e.at, locale: context.localeTag), () => []).add(e);
    }
    return Scaffold(
      appBar: AppBar(title: Text(l.statement)),
      body: _loading && _entries.isEmpty
          ? const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 6))
          : ListView(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
              children: [
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Problem(_error, describe: (e) => describeError(l, e), onRetry: _load, retryLabel: l.retry)),
                if (_entries.isEmpty && _error == null) Padding(padding: const EdgeInsets.only(top: 40), child: IllustratedEmpty(illustration: AnbessaIllustration.wallet, title: l.statementEmpty)),
                for (final g in groups.entries) ...[
                  Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text(g.key, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4))),
                  SectionGroup(
                    margin: EdgeInsets.zero,
                    children: [
                      for (final e in g.value)
                        SettingsTile(
                          icon: _icon(e.kind),
                          iconTone: e.amountMinor < 0 ? c.danger : c.success,
                          title: statementKindLabel(l, e.kind),
                          subtitle: '${clockOf(e.at)}${e.memo != null ? ' · ${e.memo}' : ''}',
                          chevron: false,
                          trailing: MoneyText(e.amountMinor, locale: context.localeTag, signed: true, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w700, color: e.amountMinor < 0 ? c.danger : c.success)),
                        ),
                    ],
                  ),
                ],
                if (_next != null) const Padding(padding: EdgeInsets.all(16), child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)))),
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
    return Scaffold(
      appBar: AppBar(title: Text(l.topUps)),
      body: b?.accountId == null
          ? IllustratedEmpty(illustration: AnbessaIllustration.wallet, title: l.statementEmpty)
          : FutureBuilder(
              future: ref.read(apisProvider).payments.topUps(b!.accountId!),
              builder: (context, snap) {
                if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e)));
                final list = snap.data;
                if (list == null) return const Padding(padding: EdgeInsets.all(16), child: SkeletonList(rows: 4));
                if (list.isEmpty) return IllustratedEmpty(illustration: AnbessaIllustration.wallet, title: l.statementEmpty);
                return ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    SectionGroup(
                      margin: EdgeInsets.zero,
                      children: [
                        for (final t in list)
                          SettingsTile(
                            icon: t.channel == 'MOBILE_MONEY' ? Icons.phone_iphone : t.channel == 'OFFICE_CASH' ? Icons.payments_outlined : Icons.account_balance_outlined,
                            title: '${t.channel == 'MOBILE_MONEY' ? l.mobileMoney : t.channel == 'OFFICE_CASH' ? l.cash : 'Bank'}${t.provider != null && t.provider != 'bank' ? ' · ${providerLabel(t.provider!)}' : ''}',
                            subtitle: dayAndTime(t.createdAt, locale: context.localeTag),
                            chevron: false,
                            trailing: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [MoneyText(t.amountMinor, locale: context.localeTag, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w700, color: c.text)), StatusPill(t.status.name, tone: t.status == TopUpStatus.succeeded ? Tone.green : t.isOpen ? Tone.amber : Tone.red)],
                            ),
                          ),
                      ],
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
      padding: const EdgeInsets.only(top: 14),
      child: SectionGroup(
        title: l.incentivesTitle,
        margin: EdgeInsets.zero,
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
                        child: Text(
                          i.name,
                          style: AnbessaType.body.copyWith(color: c.text, fontWeight: FontWeight.w600),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        l.incentiveReward(birr(i.rewardMinor, locale: loc)),
                        style: AnbessaType.body2.copyWith(color: c.text, fontFeatures: AnbessaType.tabular),
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
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Text(l.incentivesLede, style: AnbessaType.caption.copyWith(color: c.muted)),
          ),
        ],
      ),
    );
  }
}
