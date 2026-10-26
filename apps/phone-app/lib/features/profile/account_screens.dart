// Account (both modes): profile name, language, signed-in devices, payment preferences, mode
// switch, flagged entries (support, scheduled rides, promos, delete account), sign out.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/session/session_controller.dart';
import '../config/client_config_provider.dart';
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

class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key, required this.mode});
  final AppMode mode;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final session = ref.watch(currentSessionProvider);
    final version = ref.watch(appVersionProvider).value;
    final support = ref.watch(featureProvider(Feature.support));
    final scheduled = ref.watch(featureProvider(Feature.scheduledRides));
    final promos = ref.watch(featureProvider(Feature.promos));
    final deletion = ref.watch(featureProvider(Feature.accountDeletion));
    if (session == null) return const SizedBox.shrink();
    return Scaffold(
      appBar: AppBar(title: Text(l.accountTitle)),
      body: ListView(
        children: [
          ListTile(
            leading: CircleAvatar(backgroundColor: c.accentSoft, foregroundColor: c.accentStrong, child: Text(session.displayName.characters.first.toUpperCase())),
            title: Text(session.displayName, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
            subtitle: Text(formatPhone(session.profile.phone)),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push(Routes.profile),
          ),
          const Divider(),
          if (mode == AppMode.rider && session.canDrive) ListTile(leading: const Icon(Icons.drive_eta_outlined), title: Text(l.switchToDriver), onTap: () => ref.read(modeProvider.notifier).set(AppMode.driver)),
          if (mode == AppMode.rider && !session.canDrive) ListTile(leading: const Icon(Icons.drive_eta_outlined), title: Text(l.becomeDriver), subtitle: Text(l.becomeDriverLede), onTap: () => ref.read(modeProvider.notifier).set(AppMode.driver)),
          if (mode == AppMode.driver) ListTile(leading: const Icon(Icons.hail), title: Text(l.switchToRider), onTap: () => ref.read(modeProvider.notifier).set(AppMode.rider)),
          ListTile(leading: const Icon(Icons.language), title: Text(l.language), onTap: () => context.push(Routes.language)),
          if (mode == AppMode.rider) ListTile(leading: const Icon(Icons.payments_outlined), title: Text(l.paymentPreferences), onTap: () => context.push(Routes.paymentPrefs)),
          ListTile(leading: const Icon(Icons.devices_outlined), title: Text(l.sessions), onTap: () => context.push(Routes.sessions)),
          if (scheduled && mode == AppMode.rider) ListTile(leading: const Icon(Icons.schedule), title: Text(l.scheduledRides), onTap: () => context.push(Routes.scheduled)),
          if (promos && mode == AppMode.rider) ListTile(leading: const Icon(Icons.local_offer_outlined), title: Text(l.promos), onTap: () => context.push(Routes.promos)),
          if (support) ListTile(leading: const Icon(Icons.help_outline), title: Text(l.support), onTap: () => context.push(Routes.support)),
          const Divider(),
          ListTile(
            leading: Icon(Icons.logout, color: c.danger),
            title: Text(l.signOut, style: TextStyle(color: c.danger)),
            onTap: () async {
              final yes = await showDialog<bool>(
                context: context,
                builder: (ctx) => AlertDialog(
                  content: Text(l.signOutConfirm),
                  actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(l.cancel)), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(l.signOut))],
                ),
              );
              if (yes == true) await ref.read(sessionProvider.notifier).signOut();
            },
          ),
          if (deletion) ListTile(leading: Icon(Icons.delete_outline, color: c.muted), title: Text(l.deleteAccount, style: TextStyle(color: c.muted)), onTap: () => context.push(Routes.deleteAccount)),
          const SizedBox(height: 16),
          Center(child: Text(version == null ? '' : l.appVersion('${version.version}+${version.build}'), style: TextStyle(color: c.faint, fontSize: 12))),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});
  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  late final _name = TextEditingController(text: ref.read(currentSessionProvider)?.profile.name ?? '');
  bool _busy = false;
  Object? _error;
  bool _saved = false;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
      _saved = false;
    });
    try {
      final p = await ref.read(authApiProvider).updateName(_name.text.trim());
      await ref.read(sessionProvider.notifier).updateProfile(p);
      setState(() => _saved = true);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final s = ref.watch(currentSessionProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l.profile)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(controller: _name, decoration: InputDecoration(labelText: l.nameLabel), textCapitalization: TextCapitalization.words),
          const SizedBox(height: 12),
          KeyValue(l.phoneLabelShort, Text(formatPhone(s?.profile.phone))),
          const SizedBox(height: 12),
          if (_saved) Notice(l.nameSaved, tone: NoticeTone.ok),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 12),
          PrimaryButton(label: l.save, busy: _busy, onPressed: _name.text.trim().length < 2 ? null : _save),
        ],
      ),
    );
  }
}

class LanguageScreen extends ConsumerWidget {
  const LanguageScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final current = ref.watch(localeProvider)?.languageCode ?? Localizations.localeOf(context).languageCode;
    return Scaffold(
      appBar: AppBar(title: Text(l.language)),
      body: ListView(
        children: [
          RadioGroup<String>(
            groupValue: current,
            onChanged: (v) => ref.read(localeProvider.notifier).set(v == null ? null : Locale(v)),
            child: Column(children: [RadioListTile(value: 'en', title: Text(l.english)), RadioListTile(value: 'am', title: Text(l.amharic))]),
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
                  leading: const Icon(Icons.smartphone),
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
                for (final p in providers) RadioListTile(value: p.provider, title: Text(p.label), subtitle: p.isSimulated ? Text(l.simulatedProvider) : null),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
