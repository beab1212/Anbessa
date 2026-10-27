// Account (both modes): who you are, your rating and trips, and every setting grouped: Ride,
// Preferences, Safety, Account, Help, About. Flagged entries whose backend is missing show "Coming soon".

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/session/session_controller.dart';
import '../config/client_config_provider.dart';
import '../rider/history/history_screens.dart';
import 'appearance_controller.dart';
import 'settings_controllers.dart';

final myRatingProvider = FutureProvider<MyRating>((ref) async {
  if (ref.watch(currentSessionProvider) == null) return const MyRating(count: 0);
  return ref.read(apisProvider).trips.myRating();
});

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
    final deletion = ref.watch(featureProvider(Feature.accountDeletion));
    final rating = ref.watch(myRatingProvider).value;
    final trips = ref.watch(tripHistoryProvider(mode == AppMode.driver ? 'driver' : 'rider')).value?.trips.length;
    final themeMode = ref.watch(themeModeProvider);
    final orgs = ref.watch(organizationsProvider).value;
    final invites = orgs?.invitations.length ?? 0;
    if (session == null) return const SizedBox.shrink();
    final themeLabel = switch (themeMode) { ThemeMode.system => l.themeSystem, ThemeMode.light => l.themeLight, ThemeMode.dark => l.themeDark };
    final comingSoon = StatusPill(l.comingSoon, tone: Tone.grey);

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          SliverAppBar(pinned: true, title: Text(l.accountTitle)),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
            sliver: SliverList.list(
              children: [
                // who you are
                FloatingCard(
                  padding: const EdgeInsets.all(16),
                  radius: AnbessaRadius.lg,
                  child: InkWell(
                    onTap: () => context.push(Routes.profile),
                    child: Row(
                      children: [
                        AvatarImage(src: session.profile.image, name: session.displayName, size: 64, ring: true),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(session.displayName, style: AnbessaType.h2.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                              const SizedBox(height: 2),
                              Text(formatPhone(session.profile.phone), style: AnbessaType.body2.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular)),
                              const SizedBox(height: 6),
                              Row(
                                children: [
                                  RatingSummary(average: rating?.average, count: rating?.count ?? 0, newLabel: '—'),
                                  if (trips != null) ...[Text('  ·  ', style: TextStyle(color: c.faint)), Text(l.tripsCount(trips), style: AnbessaType.body2.copyWith(color: c.text2))],
                                ],
                              ),
                            ],
                          ),
                        ),
                        Icon(Icons.chevron_right_rounded, color: c.faint),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                // mode
                SectionGroup(
                  children: [
                    if (mode == AppMode.rider && session.canDrive) SettingsTile(icon: Icons.drive_eta_outlined, title: l.switchToDriver, onTap: () => ref.read(modeProvider.notifier).set(AppMode.driver)),
                    if (mode == AppMode.rider && !session.canDrive) SettingsTile(icon: Icons.drive_eta_outlined, title: l.becomeDriver, subtitle: l.becomeDriverLede, onTap: () => ref.read(modeProvider.notifier).set(AppMode.driver)),
                    if (mode == AppMode.driver) SettingsTile(icon: Icons.hail, title: l.switchToRider, onTap: () => ref.read(modeProvider.notifier).set(AppMode.rider)),
                  ],
                ),
                if (mode == AppMode.rider)
                  SectionGroup(
                    title: l.ride,
                    children: [
                      SettingsTile(icon: Icons.home_work_outlined, title: l.savedPlaces, onTap: () => context.push(Routes.savedPlaces)),
                      SettingsTile(icon: Icons.payments_outlined, title: l.paymentPreferences, onTap: () => context.push(Routes.paymentPrefs)),
                      if (scheduled) SettingsTile(icon: Icons.schedule, title: l.scheduledRides, onTap: () => context.push(Routes.scheduled)),
                    ],
                  ),
                if (mode == AppMode.driver)
                  SectionGroup(
                    title: l.driveTitle,
                    children: [
                      SettingsTile(icon: Icons.directions_car_outlined, title: l.vehicles, onTap: () => context.push(Routes.driverVehicles)),
                      SettingsTile(icon: Icons.navigation_outlined, title: l.navigation, onTap: () => context.push(Routes.navigationPrefs)),
                      SettingsTile(icon: Icons.account_balance_wallet_outlined, title: l.tabEarnings, onTap: () => context.go(Routes.driverEarnings)),
                      if (support) SettingsTile(icon: Icons.backpack_outlined, title: l.lostItems, subtitle: l.driverLostItemsTileLede, onTap: () => context.push(Routes.lostItems)),
                    ],
                  ),
                SectionGroup(
                  title: l.preferences,
                  children: [
                    SettingsValueTile(icon: Icons.language, title: l.language, value: Localizations.localeOf(context).languageCode == 'am' ? 'አማርኛ' : 'English', onTap: () => context.push(Routes.language)),
                    SettingsValueTile(icon: Icons.dark_mode_outlined, title: l.appearance, value: themeLabel, onTap: () => context.push(Routes.appearance)),
                    SettingsTile(icon: Icons.notifications_outlined, title: l.notifications, onTap: () => context.push(Routes.notifications)),
                  ],
                ),
                SectionGroup(
                  title: l.safety,
                  children: [
                    SettingsTile(icon: Icons.emergency_outlined, title: l.emergencyContact, subtitle: ref.watch(emergencyContactProvider)?.name ?? l.notSet, onTap: () => context.push(Routes.safety)),
                  ],
                ),
                SectionGroup(
                  title: l.account,
                  children: [
                    SettingsTile(
                      icon: Icons.business_outlined,
                      title: l.organizations,
                      subtitle: orgs == null ? null : (orgs.orgs.isEmpty ? l.noOrganizations : orgs.orgs.map((o) => o.name).join(', ')),
                      badge: invites > 0 ? StatusPill('$invites', tone: Tone.amber) : null,
                      onTap: () => context.push(Routes.organizations),
                    ),
                    SettingsTile(icon: Icons.devices_outlined, title: l.sessions, onTap: () => context.push(Routes.sessions)),
                  ],
                ),
                if (support) SectionGroup(title: l.support, children: [SettingsTile(icon: Icons.help_outline, title: l.support, subtitle: l.supportTileLede, onTap: () => context.push(Routes.support))]),
                SectionGroup(
                  title: l.about,
                  children: [
                    SettingsTile(
                      icon: Icons.logout,
                      title: l.signOut,
                      destructive: true,
                      chevron: false,
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
                    if (deletion) SettingsTile(icon: Icons.delete_outline, title: l.deleteAccount, iconTone: c.muted, badge: comingSoon, onTap: () => context.push(Routes.deleteAccount)),
                  ],
                ),
                Center(child: Text(version == null ? '' : l.appVersion('${version.version}+${version.build}'), style: AnbessaType.caption.copyWith(color: c.faint))),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
