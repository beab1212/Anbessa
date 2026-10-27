// Appearance, notifications, safety (emergency contact), navigation (driver) and the companies
// and fleets a person belongs to.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/ux/haptics.dart';
import '../maps/nav/external_nav.dart';
import 'appearance_controller.dart';
import 'settings_controllers.dart';

class AppearanceScreen extends ConsumerWidget {
  const AppearanceScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final mode = ref.watch(themeModeProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l.appearance)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionGroup(
            children: [
              for (final (m, title, icon) in [(ThemeMode.system, l.themeSystem, Icons.brightness_auto_outlined), (ThemeMode.light, l.themeLight, Icons.light_mode_outlined), (ThemeMode.dark, l.themeDark, Icons.dark_mode_outlined)])
                ChoiceRow(title: title, leading: Icon(icon), selected: mode == m, onTap: () => ref.read(themeModeProvider.notifier).set(m)),
            ],
          ),
        ],
      ),
    );
  }
}

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final n = ref.watch(notificationPrefsProvider);
    final h = ref.watch(hapticsSettingsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l.notifications)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionGroup(
            children: [
              SettingsSwitchTile(icon: Icons.directions_car_outlined, title: l.notifTripUpdates, subtitle: l.notifTripUpdatesLede, value: n.trip, onChanged: (v) => ref.read(notificationPrefsProvider.notifier).set(trip: v)),
              SettingsSwitchTile(icon: Icons.campaign_outlined, title: l.notifPromos, value: n.promo, onChanged: (v) => ref.read(notificationPrefsProvider.notifier).set(promo: v)),
              SettingsSwitchTile(icon: Icons.volume_up_outlined, title: l.notifSound, value: n.sound, onChanged: (v) => ref.read(notificationPrefsProvider.notifier).set(sound: v)),
            ],
          ),
          SectionGroup(
            children: [
              SettingsSwitchTile(icon: Icons.vibration, title: l.notifVibrateOffer, value: h.vibrateOnOffer, onChanged: (v) => ref.read(hapticsSettingsProvider.notifier).setVibrateOnOffer(v)),
              SettingsSwitchTile(icon: Icons.touch_app_outlined, title: l.notifHaptics, value: h.haptics, onChanged: (v) => ref.read(hapticsSettingsProvider.notifier).setHaptics(v)),
            ],
          ),
          Text(l.notifLocalOnly, style: AnbessaType.caption.copyWith(color: c.muted)),
        ],
      ),
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
      appBar: AppBar(title: Text(l.safety)),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(l.emergencyContact, style: AnbessaType.h2.copyWith(color: c.text)),
          const SizedBox(height: 6),
          Text(l.emergencyContactLede, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 20),
          TextField(controller: _name, decoration: InputDecoration(labelText: l.contactName, prefixIcon: const Icon(Icons.person_outline)), textCapitalization: TextCapitalization.words, onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: InputDecoration(labelText: l.contactPhone, prefixIcon: const Icon(Icons.phone_outlined), hintText: '+251 9…'), onChanged: (_) => setState(() {})),
          const SizedBox(height: 12),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          PrimaryButton(label: l.save, onPressed: _name.text.trim().isEmpty || _phone.text.trim().isEmpty ? null : _save),
          if (current != null)
            TextButton(
              onPressed: () async {
                await ref.read(emergencyContactProvider.notifier).set(null);
                _name.clear();
                _phone.clear();
                setState(() {});
              },
              child: Text(l.removePlace),
            ),
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
    final p = ref.watch(navPrefsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l.navigation)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SectionGroup(
            children: [
              SettingsSwitchTile(icon: Icons.explore_outlined, title: l.navFollowBearing, value: p.bearing, onChanged: (v) => ref.read(navPrefsProvider.notifier).set(bearing: v)),
              SettingsSwitchTile(icon: Icons.brightness_high_outlined, title: l.keepAwake, value: p.keepAwake, onChanged: (v) => ref.read(navPrefsProvider.notifier).set(keepAwake: v)),
            ],
          ),
          SectionGroup(
            title: l.navApp,
            children: [
              ChoiceRow(title: l.navAsk, selected: p.ask, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: true)),
              ChoiceRow(title: l.navGoogleMaps, selected: !p.ask && p.app == NavApp.google, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: false, app: NavApp.google)),
              ChoiceRow(title: l.navWaze, selected: !p.ask && p.app == NavApp.waze, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: false, app: NavApp.waze)),
              ChoiceRow(title: l.navSystemMaps, selected: !p.ask && p.app == NavApp.system, onTap: () => ref.read(navPrefsProvider.notifier).set(ask: false, app: NavApp.system)),
            ],
          ),
        ],
      ),
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
    return Scaffold(
      appBar: AppBar(title: Text(l.organizations)),
      body: RefreshIndicator(
        onRefresh: () => ref.read(organizationsProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(l.organizationsLede, style: AnbessaType.body2.copyWith(color: c.text2)),
            const SizedBox(height: 16),
            Problem(_error, describe: (e) => describeError(l, e)),
            if (data.hasError) Problem(data.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(organizationsProvider.notifier).refresh(), retryLabel: l.retry),
            if (data.isLoading && data.value == null) const SkeletonList(rows: 2),
            if (invites.isNotEmpty)
              SectionGroup(
                title: l.invitations,
                children: [
                  for (final i in invites)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(l.invitedToJoin(i.organizationName ?? i.organizationId), style: AnbessaType.body.copyWith(fontWeight: FontWeight.w600, color: c.text)),
                          Text(i.role, style: AnbessaType.caption.copyWith(color: c.muted)),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              Expanded(child: FilledButton(onPressed: _busy == null ? () => _answer(i, true) : null, child: Text(l.accept))),
                              const SizedBox(width: 8),
                              Expanded(child: OutlinedButton(onPressed: _busy == null ? () => _answer(i, false) : null, child: Text(l.decline))),
                            ],
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            if (data.value != null && orgs.isEmpty && invites.isEmpty) IllustratedEmpty(illustration: AnbessaIllustration.documents, title: l.noOrganizations, compact: true),
            if (orgs.isNotEmpty)
              SectionGroup(
                children: [
                  for (final o in orgs)
                    SettingsTile(
                      icon: o.isFleet ? Icons.local_shipping_outlined : Icons.business_outlined,
                      title: o.name,
                      subtitle: o.status,
                      chevron: false,
                      trailing: o.isCorporate && corporate.length > 1
                          ? IconButton(
                              tooltip: l.defaultBilling,
                              icon: Icon((billing ?? corporate.first.id) == o.id ? Icons.check_circle : Icons.radio_button_unchecked, color: (billing ?? corporate.first.id) == o.id ? c.accentStrong : c.borderStrong),
                              onPressed: () => ref.read(billingOrgProvider.notifier).set(o.id),
                            )
                          : null,
                    ),
                ],
              ),
            if (corporate.length > 1) Text(l.defaultBilling, style: AnbessaType.caption.copyWith(color: c.muted)),
          ],
        ),
      ),
    );
  }
}
