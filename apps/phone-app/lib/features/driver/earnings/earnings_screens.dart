// Earnings (workflow 09): the balance and its state, limits and dues; top-ups by mobile money
// (the provider's page, then `balance:topped_up`); the payout method; the statement and the list
// of top-ups.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../rider/booking/booking_controller.dart';
import 'earnings_controller.dart';

Tone balanceTone(BalanceState s) => switch (s) { BalanceState.ok => Tone.green, BalanceState.warning => Tone.amber, _ => Tone.red };

String balanceStateLabel(AppLocalizations l, BalanceState s) => switch (s) {
      BalanceState.ok => l.ok,
      BalanceState.warning => l.balanceWarningLede.split(':').first,
      BalanceState.cashBlocked => l.balanceCashBlockedLede.split('.').first,
      BalanceState.blocked => l.balanceBlockedLede.split('.').first,
      BalanceState.unknown => '—',
    };

class EarningsScreen extends ConsumerWidget {
  const EarningsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final loc = context.localeTag;
    final bAsync = ref.watch(balanceProvider);
    final b = bAsync.value;
    return Scaffold(
      appBar: AppBar(title: Text(l.earningsTitle), actions: [IconButton(onPressed: () => ref.read(balanceProvider.notifier).refresh(), icon: const Icon(Icons.refresh), tooltip: l.refresh)]),
      body: RefreshIndicator(
        onRefresh: () => ref.read(balanceProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (bAsync.hasError) Problem(bAsync.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(balanceProvider.notifier).refresh(), retryLabel: l.retry),
            if (b == null && !bAsync.hasError) const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator())),
            if (b != null) ...[
              SectionCard(
                title: l.balanceTitle,
                trailing: StatusPill(balanceStateLabel(l, b.state), tone: balanceTone(b.state)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      b.balanceMinor == 0 ? l.balanceZero : b.owes ? l.youOwe(birr(-b.balanceMinor, locale: loc)) : l.weOweYou(birr(b.balanceMinor, locale: loc)),
                      style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: b.owes ? c.danger : c.text, fontFamilyFallback: monoFamilyFallback),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      switch (b.state) {
                        BalanceState.ok => l.balanceOkLede,
                        BalanceState.warning => l.balanceWarningLede,
                        BalanceState.cashBlocked => l.balanceCashBlockedLede,
                        BalanceState.blocked => l.balanceBlockedLede,
                        BalanceState.unknown => '',
                      },
                      style: TextStyle(color: c.text2),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      b.policy.prepaid ? l.prepaidLine(birr(b.policy.prepaidMinimumMinor, locale: loc)) : l.limitsLine(birr(b.policy.warningMinor, locale: loc), birr(b.policy.cashLimitMinor, locale: loc), birr(b.policy.hardLimitMinor, locale: loc)),
                      style: TextStyle(color: c.muted, fontSize: 12),
                    ),
                    for (final d in b.openDues) ...[
                      const SizedBox(height: 10),
                      Notice(
                        '${d.status == 'OVERDUE' ? '${l.paymentOverdue}: ' : ''}${l.paymentDueLine(birr(d.minimumLeftMinor, locale: loc), dayOf(d.dueAt, locale: loc))}',
                        tone: d.status == 'OVERDUE' ? NoticeTone.error : NoticeTone.warning,
                      ),
                    ],
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(child: PrimaryButton(label: l.topUp, icon: Icons.add, onPressed: () => context.push(Routes.driverTopUp))),
                        const SizedBox(width: 8),
                        Expanded(child: OutlinedButton(onPressed: b.accountId == null ? null : () => context.push(Routes.driverStatement), child: Text(l.statement))),
                      ],
                    ),
                    if (b.suggestedTopUpMinor > 0) Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.suggestedTopUp(birr(b.suggestedTopUpMinor, locale: loc)), style: TextStyle(color: c.muted, fontSize: 12))),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              SectionCard(
                title: l.payoutMethod,
                trailing: TextButton(onPressed: b.accountId == null ? null : () => context.push(Routes.driverPayoutMethod), child: Text(l.save)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(b.payoutMethod == null ? l.noPayoutMethod : '${providerLabel(b.payoutMethod!.provider)} ${b.payoutMethod!.destination ?? ''}', style: TextStyle(color: b.payoutMethod == null ? c.warning : c.text, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(l.payoutsWeekly(birr(b.policy.minPayoutMinor, locale: loc)), style: TextStyle(color: c.muted, fontSize: 12)),
                  ],
                ),
              ),
              if (b.referenceCode != null) ...[
                const SizedBox(height: 12),
                SectionCard(
                  title: l.referenceCode,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      MonoText(b.referenceCode!, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: 2)),
                      const SizedBox(height: 4),
                      Text(l.referenceCodeHint, style: TextStyle(color: c.muted, fontSize: 12)),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 12),
              if (b.accountId != null) ListTile(leading: const Icon(Icons.history), title: Text(l.topUps), trailing: const Icon(Icons.chevron_right), onTap: () => context.push(Routes.driverTopUps)),
            ],
          ],
        ),
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
          ref.read(balanceProvider.notifier).refresh();
        }
      });
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
    final loc = context.localeTag;
    final methods = ref.watch(paymentMethodsProvider).value ?? PaymentMethodsConfig.fallback;
    final providers = methods.providers.where((p) => p.takesMobileMoney).toList();
    final provider = _provider ?? providers.firstOrNull?.provider;
    final minor = toMinor(_amount.text);
    final started = _started;
    return Scaffold(
      appBar: AppBar(title: Text(l.topUpTitle)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (started != null) ...[
            if (started.status == TopUpStatus.succeeded)
              Notice(l.topUpCredited(birr(started.amountMinor, locale: loc)), tone: NoticeTone.ok)
            else if (started.status == TopUpStatus.failed)
              Notice(started.failure ?? l.paymentFailed, tone: NoticeTone.error)
            else
              Notice(started.instructions ?? l.topUpStarted(providerLabel(started.provider ?? '')), tone: NoticeTone.info),
            const SizedBox(height: 12),
            if (started.isOpen && started.checkoutUrl != null) OutlinedButton.icon(onPressed: () => launchUrl(Uri.parse(started.checkoutUrl!), mode: LaunchMode.inAppBrowserView), icon: const Icon(Icons.open_in_new), label: Text(l.openPaymentPage)),
            const SizedBox(height: 8),
            PrimaryButton(label: l.done, onPressed: () => context.pop()),
          ] else ...[
            TextField(controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: InputDecoration(labelText: l.topUpAmount, prefixText: 'ETB '), onChanged: (_) => setState(() {})),
            const SizedBox(height: 16),
            Text(l.topUpProvider, style: TextStyle(color: c.muted, fontWeight: FontWeight.w600, fontSize: 12)),
            RadioGroup<String>(
              groupValue: provider,
              onChanged: (v) => setState(() => _provider = v),
              child: Column(children: [for (final p in providers) RadioListTile(value: p.provider, title: Text(p.label), subtitle: p.isSimulated ? Text(l.simulatedProvider) : null, contentPadding: EdgeInsets.zero)]),
            ),
            const SizedBox(height: 8),
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
          Text(l.payoutMethodLede, style: TextStyle(color: c.text2)),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _provider,
            decoration: InputDecoration(labelText: l.payoutProvider),
            items: const [DropdownMenuItem(value: 'telebirr', child: Text('telebirr')), DropdownMenuItem(value: 'cbebirr', child: Text('CBE Birr')), DropdownMenuItem(value: 'chapa', child: Text('Bank account (Chapa)'))],
            onChanged: (v) => setState(() => _provider = v ?? _provider),
          ),
          const SizedBox(height: 12),
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

  @override
  void initState() {
    super.initState();
    _load();
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

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(l.statement)),
      body: _loading && _entries.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              children: [
                if (_error != null) Padding(padding: const EdgeInsets.all(16), child: Problem(_error, describe: (e) => describeError(l, e), onRetry: _load, retryLabel: l.retry)),
                if (_entries.isEmpty && _error == null) EmptyState(icon: Icons.receipt_long_outlined, title: l.statementEmpty),
                for (final e in _entries)
                  ListTile(
                    title: Text(statementKindLabel(l, e.kind)),
                    subtitle: Text('${dayAndTime(e.at, locale: context.localeTag)}${e.memo != null ? ' · ${e.memo}' : ''}'),
                    trailing: MoneyText(e.amountMinor, locale: context.localeTag, signed: true, style: TextStyle(fontWeight: FontWeight.w700, color: e.amountMinor < 0 ? c.danger : c.success)),
                  ),
                if (_next != null) TextButton(onPressed: () => _load(more: true), child: Text(l.next)),
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
    final b = ref.watch(balanceProvider).value;
    return Scaffold(
      appBar: AppBar(title: Text(l.topUps)),
      body: b?.accountId == null
          ? EmptyState(title: l.statementEmpty)
          : FutureBuilder(
              future: ref.read(apisProvider).payments.topUps(b!.accountId!),
              builder: (context, snap) {
                if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e)));
                final list = snap.data;
                if (list == null) return const Center(child: CircularProgressIndicator());
                if (list.isEmpty) return EmptyState(title: l.statementEmpty);
                return ListView(
                  children: [
                    for (final t in list)
                      ListTile(
                        title: Text('${t.channel == 'MOBILE_MONEY' ? l.mobileMoney : t.channel == 'OFFICE_CASH' ? l.cash : 'Bank'}${t.provider != null && t.provider != 'bank' ? ' · ${providerLabel(t.provider!)}' : ''}'),
                        subtitle: Text(dayAndTime(t.createdAt, locale: context.localeTag)),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [MoneyText(t.amountMinor, locale: context.localeTag, style: const TextStyle(fontWeight: FontWeight.w700)), StatusPill(t.status.name, tone: t.status == TopUpStatus.succeeded ? Tone.green : t.isOpen ? Tone.amber : Tone.red)],
                        ),
                      ),
                  ],
                );
              },
            ),
    );
  }
}
