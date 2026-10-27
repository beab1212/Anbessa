// Language, signed-in devices and payment preferences (the account hub itself is account_hub_screen.dart).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../rider/booking/booking_controller.dart';

class LocaleController extends Notifier<Locale?> {
  static const _key = 'locale';
  @override
  Locale? build() {
    final s = ref.watch(prefsProvider).getString(_key);
    return s == null ? null : Locale(s);
  }

  Future<void> set(Locale? l) async {
    state = l;
    final p = ref.read(prefsProvider);
    if (l == null) {
      await p.remove(_key);
    } else {
      await p.setString(_key, l.languageCode);
    }
  }
}

final localeProvider = NotifierProvider<LocaleController, Locale?>(LocaleController.new);

class LanguageScreen extends ConsumerWidget {
  const LanguageScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final current = ref.watch(localeProvider)?.languageCode ?? Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.language)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionGroup(
            children: [
              ChoiceRow(title: l.english, subtitle: 'English', leading: const Icon(Icons.language_rounded), selected: current == 'en', onTap: () => ref.read(localeProvider.notifier).set(const Locale('en'))),
              ChoiceRow(title: l.amharic, subtitle: 'አማርኛ', leading: const Icon(Icons.translate_rounded), selected: current == 'am', onTap: () => ref.read(localeProvider.notifier).set(const Locale('am'))),
            ],
          ),
        ],
      ),
    );
  }
}

class SessionsScreen extends ConsumerStatefulWidget {
  const SessionsScreen({super.key});
  @override
  ConsumerState<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends ConsumerState<SessionsScreen> {
  late Future<List<SessionInfo>> _list = ref.read(authApiProvider).listSessions();
  void _reload() => setState(() => _list = ref.read(authApiProvider).listSessions());

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(l.sessions)),
      body: FutureBuilder(
        future: _list,
        builder: (context, snap) {
          if (snap.hasError) return Padding(padding: const EdgeInsets.all(16), child: Problem(snap.error, describe: (e) => describeError(l, e), onRetry: _reload, retryLabel: l.retry));
          final list = snap.data;
          if (list == null) return const Center(child: CircularProgressIndicator());
          return ListView(
            children: [
              Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 4), child: Text(l.sessionsLede, style: TextStyle(color: c.text2))),
              for (final s in list)
                ListTile(
                  leading: Icon(_deviceIcon(s.userAgent), color: c.text2),
                  title: Text(s.userAgent ?? l.thisDevice, maxLines: 1, overflow: TextOverflow.ellipsis),
                  subtitle: Text('${dayAndTime(s.createdAt, locale: context.localeTag)}${s.ipAddress != null ? ' · ${s.ipAddress}' : ''}'),
                  trailing: TextButton(
                    onPressed: () async {
                      await ref.read(authApiProvider).revokeSession(s.token);
                      _reload();
                    },
                    child: Text(l.signOutDevice),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: OutlinedButton(
                  onPressed: () async {
                    await ref.read(authApiProvider).revokeOtherSessions();
                    _reload();
                  },
                  child: Text(l.signOutEverywhere),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

IconData _deviceIcon(String? userAgent) {
  final ua = (userAgent ?? '').toLowerCase();
  if (ua.contains('iphone') || ua.contains('android') || ua.contains('dart')) return Icons.smartphone_rounded;
  if (ua.contains('ipad') || ua.contains('tablet')) return Icons.tablet_rounded;
  return Icons.computer_rounded;
}

class PaymentPreferencesScreen extends ConsumerStatefulWidget {
  const PaymentPreferencesScreen({super.key});
  @override
  ConsumerState<PaymentPreferencesScreen> createState() => _PaymentPreferencesScreenState();
}

class _PaymentPreferencesScreenState extends ConsumerState<PaymentPreferencesScreen> {
  String? _current;
  Object? _error;
  @override
  void initState() {
    super.initState();
    ref.read(apisProvider).payments.preference().then((v) => mounted ? setState(() => _current = v) : null).catchError((e) => mounted ? setState(() => _error = e) : null);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final methods = ref.watch(paymentMethodsProvider).value ?? PaymentMethodsConfig.fallback;
    final providers = methods.providers.where((p) => p.takesMobileMoney).toList();
    return Scaffold(
      appBar: AppBar(title: Text(l.paymentPreferences)),
      body: ListView(
        children: [
          Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 4), child: Text(l.preferredMobileMoneyLede, style: TextStyle(color: c.text2))),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Problem(_error, describe: (e) => describeError(l, e))),
          RadioGroup<String>(
            groupValue: _current,
            onChanged: (v) async {
              if (v == null) return;
              setState(() => _current = v);
              try {
                await ref.read(apisProvider).payments.setPreference(v);
              } catch (e) {
                setState(() => _error = e);
              }
            },
            child: Column(
              children: [
                for (final p in providers) RadioListTile(value: p.provider, secondary: Icon(Icons.phone_iphone_rounded, color: c.text2), title: Text(p.label), subtitle: p.isSimulated ? Text(l.simulatedProvider) : null),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
