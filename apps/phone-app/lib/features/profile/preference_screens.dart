// App Appearance, Notifications (the kit's p. 169: switches in one card), the emergency contact,
// navigation (driver) and the companies and fleets a person belongs to, in the GoRide kit's look.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/ux/haptics.dart';
import '../maps/nav/external_nav.dart';
import 'account_screens.dart' show AccountLede, AccountPage, OptionCard;
import 'appearance_controller.dart';
import 'settings_controllers.dart';

class AppearanceScreen extends ConsumerWidget {
  const AppearanceScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final mode = ref.watch(themeModeProvider);
    return AccountPage(
      title: l.accAppAppearance,
      children: [
        for (final (m, title, icon) in [(ThemeMode.system, l.themeSystem, Icons.brightness_auto_rounded), (ThemeMode.light, l.themeLight, Icons.light_mode_outlined), (ThemeMode.dark, l.themeDark, Icons.dark_mode_outlined)])
          OptionCard(title: title, icon: icon, selected: mode == m, onTap: () => ref.read(themeModeProvider.notifier).set(m)),
      ],
    );
  }
}

/// A kit settings row: the title (a grey line under it), a switch on the right.
class SwitchRow extends StatelessWidget {
  const SwitchRow({super.key, required this.title, this.subtitle, required this.value, required this.onChanged});
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return MergeSemantics(
      child: InkWell(
        onTap: onChanged == null ? null : () => onChanged!(!value),
        child: Container(
          constraints: const BoxConstraints(minHeight: 60),
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: AnbessaType.body.copyWith(color: c.text, fontWeight: FontWeight.w600)),
                    if (subtitle != null) ...[const SizedBox(height: 2), Text(subtitle!, style: AnbessaType.caption.copyWith(color: c.muted))],
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Switch(value: value, onChanged: onChanged),
            ],
          ),
        ),
      ),
    );
  }
}

/// Rows in one kit card, with soft hairlines between them and room below the card.
class CardColumn extends StatelessWidget {
  const CardColumn({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: AppCard(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (i, w) in children.indexed) ...[
              if (i > 0) Divider(height: 1, thickness: 1, color: c.border.withValues(alpha: 0.8)),
              w,
            ],
          ],
        ),
      ),
    );
  }
}

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final n = ref.watch(notificationPrefsProvider);
    final h = ref.watch(hapticsSettingsProvider);
    final marketing = ref.watch(marketingPrefsProvider);
    final m = marketing.value;
    Future<void> setMarketing({bool? push, bool? sms}) async {
      try {
        await ref.read(marketingPrefsProvider.notifier).set(push: push, sms: sms);
      } catch (e) {
        if (context.mounted) showToast(context, describeError(l, e), tone: NoticeTone.error);
      }
    }

    return AccountPage(
      title: l.notifications,
      children: [
        Padding(padding: const EdgeInsets.fromLTRB(4, 4, 4, 14), child: Text(l.marketingTitle, style: AnbessaType.title.copyWith(color: context.colors.text))),
        CardColumn(
          children: [
            if (marketing.isLoading && m == null)
              const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: SkeletonList(rows: 2, avatar: false))
            else if (m == null)
              Padding(padding: const EdgeInsets.symmetric(vertical: 10), child: Problem(marketing.error, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(marketingPrefsProvider), retryLabel: l.retry))
            else ...[
              SwitchRow(title: l.marketingPush, value: m.push, onChanged: (v) => setMarketing(push: v)),
              SwitchRow(title: l.marketingSms, value: m.sms, onChanged: (v) => setMarketing(sms: v)),
            ],
          ],
        ),
        AccountLede(l.marketingLede),
        CardColumn(
          children: [
            SwitchRow(title: l.notifTripUpdates, subtitle: l.notifTripUpdatesLede, value: n.trip, onChanged: (v) => ref.read(notificationPrefsProvider.notifier).set(trip: v)),
            SwitchRow(title: l.notifSound, value: n.sound, onChanged: (v) => ref.read(notificationPrefsProvider.notifier).set(sound: v)),
            SwitchRow(title: l.notifVibrateOffer, value: h.vibrateOnOffer, onChanged: (v) => ref.read(hapticsSettingsProvider.notifier).setVibrateOnOffer(v)),
            SwitchRow(title: l.notifHaptics, value: h.haptics, onChanged: (v) => ref.read(hapticsSettingsProvider.notifier).setHaptics(v)),
          ],
        ),
        AccountLede(l.notifOtherLocal),
      ],
    );
  }
}

class SafetyScreen extends ConsumerStatefulWidget {
  const SafetyScreen({super.key});
  @override
  ConsumerState<SafetyScreen> createState() => _SafetyScreenState();
}

class _SafetyScreenState extends ConsumerState<SafetyScreen> {
  late final _name = TextEditingController(text: ref.read(emergencyContactProvider)?.name ?? '');
  late final _phone = TextEditingController(text: ref.read(emergencyContactProvider)?.phone ?? '');
  Object? _error;

  Future<void> _save() async {
    final l = context.l10n;
    final e164 = toE164(_phone.text);
    if (e164 == null) return setState(() => _error = AppError(status: 400, code: 'phone', message: l.phoneInvalid));
    await ref.read(emergencyContactProvider.notifier).set(EmergencyContact(name: _name.text.trim(), phone: e164));
    Haptics.success();
    if (mounted) showToast(context, l.saved, tone: NoticeTone.ok);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final current = ref.watch(emergencyContactProvider);
    return Scaffold(
      appBar: AppTopBar(title: l.emergencyContact),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 20),
              children: [
                const Center(child: ResultBadge(icon: Icons.emergency_outlined, size: 64, danger: true)),
                const SizedBox(height: 16),
                Text(l.emergencyContactLede, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.text2, fontWeight: FontWeight.w400)),
                const SizedBox(height: 28),
                FilledField(label: l.contactName, hint: l.contactName, icon: Icons.person_outline_rounded, controller: _name, textCapitalization: TextCapitalization.words, onChanged: (_) => setState(() {})),
                const SizedBox(height: 24),
                FilledField(label: l.contactPhone, hint: '+251 9…', icon: Icons.phone_outlined, controller: _phone, keyboardType: TextInputType.phone, onChanged: (_) => setState(() {})),
                const SizedBox(height: 12),
                Problem(_error, describe: (e) => describeError(l, e)),
                if (current != null)
                  Center(
                    child: TextButton.icon(
                      style: TextButton.styleFrom(foregroundColor: c.danger),
                      icon: const Icon(Icons.delete_outline_rounded),
                      onPressed: () async {
                        await ref.read(emergencyContactProvider.notifier).set(null);
                        _name.clear();
                        _phone.clear();
                        setState(() {});
                      },
                      label: Text(l.removePlace),
                    ),
                  ),
              ],
            ),
          ),
          BottomActionBar(child: PillButton(label: l.save, onPressed: _name.text.trim().isEmpty || _phone.text.trim().isEmpty ? null : _save)),
        ],
      ),
    );
  }
}

class NavigationPrefsScreen extends ConsumerWidget {
  const NavigationPrefsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final p = ref.watch(navPrefsProvider);
    return AccountPage(
      title: l.navigation,
      children: [
        CardColumn(
          children: [
            SwitchRow(title: l.navFollowBearing, value: p.bearing, onChanged: (v) => ref.read(navPrefsProvider.notifier).set(bearing: v)),
            SwitchRow(title: l.keepAwake, value: p.keepAwake, onChanged: (v) => ref.read(navPrefsProvider.notifier).set(keepAwake: v)),
          ],
        ),
        Padding(padding: const EdgeInsets.fromLTRB(4, 8, 4, 14), child: Text(l.navApp, style: AnbessaType.title.copyWith(color: c.text))),
        OptionCard(title: l.navAsk, icon: Icons.help_outline_rounded, selected: p.ask, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: true)),
        OptionCard(title: l.navGoogleMaps, icon: Icons.map_outlined, selected: !p.ask && p.app == NavApp.google, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: false, app: NavApp.google)),
        OptionCard(title: l.navWaze, icon: Icons.directions_outlined, selected: !p.ask && p.app == NavApp.waze, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: false, app: NavApp.waze)),
        OptionCard(title: l.navSystemMaps, icon: Icons.navigation_outlined, selected: !p.ask && p.app == NavApp.system, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: false, app: NavApp.system)),
      ],
    );
  }
}

class OrganizationsScreen extends ConsumerStatefulWidget {
  const OrganizationsScreen({super.key});
  @override
  ConsumerState<OrganizationsScreen> createState() => _OrganizationsScreenState();
}

class _OrganizationsScreenState extends ConsumerState<OrganizationsScreen> {
  String? _busy;
  Object? _error;

  Future<void> _answer(OrgInvitation i, bool accept) async {
    setState(() {
      _busy = i.id;
      _error = null;
    });
    try {
      await ref.read(organizationsProvider.notifier).answer(i, accept: accept);
      Haptics.success();
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final data = ref.watch(organizationsProvider);
    final billing = ref.watch(billingOrgProvider);
    final orgs = data.value?.orgs ?? const <Organization>[];
    final invites = data.value?.invitations ?? const <OrgInvitation>[];
    final corporate = orgs.where((o) => o.isCorporate).toList();
    return AccountPage(
      title: l.organizations,
      onRefresh: () => ref.read(organizationsProvider.notifier).refresh(),
      children: [
        AccountLede(l.organizationsLede),
        Problem(_error, describe: (e) => describeError(l, e)),
        if (data.hasError) Problem(data.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(organizationsProvider.notifier).refresh(), retryLabel: l.retry),
        if (data.isLoading && data.value == null) const SkeletonList(rows: 2),
        if (invites.isNotEmpty) ...[
          Padding(padding: const EdgeInsets.fromLTRB(4, 4, 4, 10), child: Text(l.invitations, style: AnbessaType.title.copyWith(color: c.text))),
          for (final i in invites)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ListRowTile(icon: Icons.mail_outline_rounded, title: l.invitedToJoin(i.organizationName ?? i.organizationId), subtitle: i.role, padding: EdgeInsets.zero),
                    const SizedBox(height: 14),
                    PillButtonPair(
                      first: PillButton(label: l.decline, variant: PillVariant.tonal, compact: true, onPressed: _busy == null ? () => _answer(i, false) : null),
                      second: PillButton(label: l.accept, compact: true, busy: _busy == i.id, onPressed: _busy == null ? () => _answer(i, true) : null),
                    ),
                  ],
                ),
              ),
            ),
        ],
        if (data.value != null && orgs.isEmpty && invites.isEmpty) IllustratedEmpty(illustration: AnbessaIllustration.documents, title: l.noOrganizations, compact: true),
        for (final o in orgs)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: AppCard(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
              child: ListRowTile(
                icon: o.isFleet ? Icons.local_shipping_outlined : Icons.business_outlined,
                title: o.name,
                subtitle: o.status,
                trailing: o.isCorporate && corporate.length > 1
                    ? IconButton(
                        tooltip: l.defaultBilling,
                        icon: Icon((billing ?? corporate.first.id) == o.id ? Icons.check_circle_rounded : Icons.radio_button_unchecked_rounded, color: (billing ?? corporate.first.id) == o.id ? c.accentText : c.borderStrong),
                        onPressed: () => ref.read(billingOrgProvider.notifier).set(o.id),
                      )
                    : null,
              ),
            ),
          ),
        if (corporate.length > 1) AccountLede(l.defaultBilling),
      ],
    );
  }
}
