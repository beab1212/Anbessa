// Language, Account & Security (signed-in devices, delete account) and payment methods, in the
// GoRide kit's look (pp. 170, 178). The account hub itself is account_hub_screen.dart.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
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

/// A page of cards on the grouped background with the kit's top bar; [footer] is pinned.
class AccountPage extends StatelessWidget {
  const AccountPage({super.key, required this.title, required this.children, this.footer, this.onRefresh});
  final String title;
  final List<Widget> children;
  final Widget? footer;
  final Future<void> Function()? onRefresh;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget list = ListView(padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24), children: children);
    if (onRefresh != null) list = RefreshIndicator(onRefresh: onRefresh!, child: list);
    return Scaffold(
      backgroundColor: c.groupedPage,
      appBar: AppTopBar(title: title, background: c.groupedPage),
      body: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [Expanded(child: list), if (footer != null) BottomActionBar(child: footer!)]),
    );
  }
}

/// A grey line of explanation between cards.
class AccountLede extends StatelessWidget {
  const AccountLede(this.text, {super.key, this.top = 0, this.bottom = 12});
  final String text;
  final double top;
  final double bottom;
  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.fromLTRB(4, top, 4, bottom),
        child: Text(text, style: AnbessaType.body2.copyWith(color: context.colors.muted, fontWeight: FontWeight.w400)),
      );
}

/// One option as a kit selectable card: a circle icon, a title and a grey line.
class OptionCard extends StatelessWidget {
  const OptionCard({super.key, required this.selected, required this.title, this.subtitle, this.icon, this.leading, required this.onTap});
  final bool selected;
  final String title;
  final String? subtitle;
  final IconData? icon;
  final Widget? leading;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: SelectableCard(
        selected: selected,
        onTap: onTap,
        child: Row(
          children: [
            leading ?? CircleIcon(icon ?? Icons.circle_outlined, color: selected ? c.onAccent : c.text, fill: selected ? c.accent : null, borderColor: selected ? c.accent : null),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: AnbessaType.title.copyWith(color: c.text)),
                  if (subtitle != null) ...[const SizedBox(height: 2), Text(subtitle!, style: AnbessaType.caption.copyWith(color: c.muted))],
                ],
              ),
            ),
          ],
        ),
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
    return AccountPage(
      title: l.language,
      children: [
        OptionCard(title: l.english, subtitle: 'English', icon: Icons.language_rounded, selected: current == 'en', onTap: () => ref.read(localeProvider.notifier).set(const Locale('en'))),
        OptionCard(title: l.amharic, subtitle: 'አማርኛ', icon: Icons.translate_rounded, selected: current == 'am', onTap: () => ref.read(localeProvider.notifier).set(const Locale('am'))),
      ],
    );
  }
}

/// Account & Security (the kit's p. 170): Device Management (the signed-in devices) and, when
/// the flag is on, a red Delete Account, each with a grey description.
class AccountSecurityScreen extends ConsumerWidget {
  const AccountSecurityScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final deletion = ref.watch(featureProvider(Feature.accountDeletion));
    Widget row(String title, String lede, VoidCallback onTap, {Color? color, bool divider = false}) => Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: onTap,
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 14),
              decoration: divider ? BoxDecoration(border: Border(bottom: BorderSide(color: c.border))) : null,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: AnbessaType.title.copyWith(color: color ?? c.text)),
                        const SizedBox(height: 6),
                        Text(lede, style: AnbessaType.caption.copyWith(color: c.muted)),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, color: c.text)),
                ],
              ),
            ),
          ),
        );
    return AccountPage(
      title: l.accAccountSecurity,
      children: [
        AppCard(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            children: [
              row(l.accDeviceManagement, l.accDeviceManagementLede, () => context.push(Routes.sessions)),
              if (deletion) row(l.deleteAccount, l.accDeleteAccountLede, () => context.push(Routes.deleteAccount), color: c.danger),
            ],
          ),
        ),
      ],
    );
  }
}

/// Device Management: every signed-in device as a card, with "Sign out" on each and "Sign out
/// everywhere else" pinned.
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
    return FutureBuilder(
      future: _list,
      builder: (context, snap) {
        final list = snap.data;
        return AccountPage(
          title: l.accDeviceManagement,
          onRefresh: () async => _reload(),
          footer: list == null
              ? null
              : PillButton(
                  label: l.signOutEverywhere,
                  variant: PillVariant.outlineDanger,
                  onPressed: () async {
                    await ref.read(authApiProvider).revokeOtherSessions();
                    _reload();
                  },
                ),
          children: [
            AccountLede(l.sessionsLede),
            if (snap.hasError) Problem(snap.error, describe: (e) => describeError(l, e), onRetry: _reload, retryLabel: l.retry),
            if (list == null && !snap.hasError) const SkeletonList(rows: 2),
            for (final s in list ?? const <SessionInfo>[])
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: AppCard(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  child: ListRowTile(
                    icon: _deviceIcon(s.userAgent),
                    title: s.userAgent ?? l.thisDevice,
                    subtitle: '${dayAndTime(s.createdAt, locale: context.localeTag)}${s.ipAddress != null ? ' · ${s.ipAddress}' : ''}',
                    trailing: TextButton(
                      style: TextButton.styleFrom(foregroundColor: c.danger, visualDensity: VisualDensity.compact),
                      onPressed: () async {
                        await ref.read(authApiProvider).revokeSession(s.token);
                        _reload();
                      },
                      child: Text(l.signOutDevice),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

IconData _deviceIcon(String? userAgent) {
  final ua = (userAgent ?? '').toLowerCase();
  if (ua.contains('iphone') || ua.contains('android') || ua.contains('dart')) return Icons.smartphone_rounded;
  if (ua.contains('ipad') || ua.contains('tablet')) return Icons.tablet_rounded;
  return Icons.computer_rounded;
}

/// Payment Methods (the kit's p. 178): the mobile-money providers as cards; the preferred one is
/// selected and marked "Preferred".
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

  Future<void> _choose(String v) async {
    setState(() => _current = v);
    try {
      await ref.read(apisProvider).payments.setPreference(v);
    } catch (e) {
      setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final methods = ref.watch(paymentMethodsProvider).value ?? PaymentMethodsConfig.fallback;
    final providers = methods.providers.where((p) => p.takesMobileMoney).toList();
    return AccountPage(
      title: l.accPaymentMethods,
      children: [
        AccountLede(l.preferredMobileMoneyLede),
        Problem(_error, describe: (e) => describeError(l, e)),
        for (final p in providers)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: SelectableCard(
              selected: _current == p.provider,
              showCheck: false,
              onTap: () => _choose(p.provider),
              child: Row(
                children: [
                  CircleIcon(Icons.phone_iphone_rounded, size: 48, color: _current == p.provider ? c.onAccent : c.text, fill: _current == p.provider ? c.accent : null, borderColor: _current == p.provider ? c.accent : null),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(p.label, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                        if (p.isSimulated) ...[const SizedBox(height: 2), Text(l.simulatedProvider, style: AnbessaType.caption.copyWith(color: c.muted))],
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(_current == p.provider ? l.accPreferred : l.accChoose, style: AnbessaType.body2.copyWith(color: _current == p.provider ? c.accentText : c.muted, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
