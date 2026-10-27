// Account (both modes): a large header (photo, name, phone, rating · trips; tap → profile), a row
// of quick actions (Trips, Help, Places or Earnings, Settings), then every setting in grouped
// cards with an icon on each row: mode, Ride or Drive, Preferences, Safety, Account, Help,
// sign out and About. Flagged entries whose backend is missing show "Coming soon".

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
import '../rider/payments/payment_due_controller.dart';
import '../rider/trip/active_trip_controller.dart';
import 'appearance_controller.dart';
import 'settings_controllers.dart';

final myRatingProvider = FutureProvider<MyRating>((ref) async {
  if (ref.watch(currentSessionProvider) == null) return const MyRating(count: 0);
  return ref.read(apisProvider).trips.myRating();
});

/// How many trips the header shows. There is no count endpoint, so this is one page of history
/// (up to [tripCountPage]; `more` when there are further pages, shown as "20+ trips"). When the
/// Activity list is already loaded its numbers are reused instead of asking again. The full
/// history is never watched: paging through Activity doesn't rebuild the account screen. A trip
/// ending re-counts (the same key as the payment badge).
const tripCountPage = 20;
typedef TripCount = ({int count, bool more});

final tripCountProvider = FutureProvider.family<TripCount, String>((ref, as) async {
  ref.watch(activeTripProvider.select(paymentDueKeyOf));
  if (ref.watch(currentSessionProvider) == null) return (count: 0, more: false);
  final history = tripHistoryProvider(as);
  if (ref.exists(history)) {
    final h = ref.read(history).value;
    if (h != null) return (count: h.trips.length, more: h.next != null);
  }
  final page = await ref.read(apisProvider).trips.list(as: as, limit: tripCountPage);
  return (count: page.trips.length, more: page.next != null);
});

/// The Hero tag of the signed-in person's photo (account header → profile).
const meAvatarHeroTag = 'me-avatar';

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
    final themeMode = ref.watch(themeModeProvider);
    final orgs = ref.watch(organizationsProvider).value;
    final invites = orgs?.invitations.length ?? 0;
    if (session == null) return const SizedBox.shrink();
    final driver = mode == AppMode.driver;
    final themeLabel = switch (themeMode) { ThemeMode.system => l.themeSystem, ThemeMode.light => l.themeLight, ThemeMode.dark => l.themeDark };
    final comingSoon = StatusPill(l.comingSoon, tone: Tone.grey);

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          SliverAppBar(pinned: true, title: Text(l.accountTitle)),
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            sliver: SliverList.list(
              children: [
                _Header(session: session, mode: mode),
                const SizedBox(height: 12),
                // quick actions
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    QuickActionCircle(icon: Icons.receipt_long_rounded, label: l.quickTrips, onTap: () => context.go(driver ? Routes.driverActivity : Routes.riderActivity)),
                    if (support) QuickActionCircle(icon: Icons.support_agent_rounded, label: l.support, onTap: () => context.push(Routes.support)),
                    if (driver)
                      QuickActionCircle(icon: Icons.account_balance_wallet_rounded, label: l.tabEarnings, onTap: () => context.go(Routes.driverEarnings))
                    else
                      QuickActionCircle(icon: Icons.bookmark_rounded, label: l.quickPlaces, onTap: () => context.push(Routes.savedPlaces)),
                    QuickActionCircle(icon: Icons.tune_rounded, label: l.quickSettings, onTap: () => context.push(Routes.appearance)),
                  ],
                ),
                const SizedBox(height: 20),
                // mode
                SectionGroup(
                  children: [
                    if (!driver && session.canDrive) SettingsTile(icon: Icons.drive_eta_rounded, iconTone: c.accentStrong, title: l.switchToDriver, onTap: () => ref.read(modeProvider.notifier).set(AppMode.driver)),
                    if (!driver && !session.canDrive) SettingsTile(icon: Icons.drive_eta_rounded, iconTone: c.accentStrong, title: l.becomeDriver, subtitle: l.becomeDriverLede, onTap: () => ref.read(modeProvider.notifier).set(AppMode.driver)),
                    if (driver) SettingsTile(icon: Icons.hail_rounded, iconTone: c.accentStrong, title: l.switchToRider, onTap: () => ref.read(modeProvider.notifier).set(AppMode.rider)),
                  ],
                ),
                if (!driver)
                  SectionGroup(
                    title: l.ride,
                    children: [
                      SettingsTile(icon: Icons.bookmark_rounded, title: l.savedPlaces, onTap: () => context.push(Routes.savedPlaces)),
                      SettingsTile(icon: Icons.payments_rounded, title: l.paymentPreferences, onTap: () => context.push(Routes.paymentPrefs)),
                      if (scheduled) SettingsTile(icon: Icons.event_rounded, title: l.scheduledRides, onTap: () => context.push(Routes.scheduled)),
                    ],
                  ),
                if (driver)
                  SectionGroup(
                    title: l.driveTitle,
                    children: [
                      SettingsTile(icon: Icons.directions_car_rounded, title: l.vehicles, onTap: () => context.push(Routes.driverVehicles)),
                      SettingsTile(icon: Icons.navigation_rounded, title: l.navigation, onTap: () => context.push(Routes.navigationPrefs)),
                      SettingsTile(icon: Icons.account_balance_wallet_rounded, title: l.tabEarnings, onTap: () => context.go(Routes.driverEarnings)),
                      if (support) SettingsTile(icon: Icons.backpack_rounded, title: l.lostItems, subtitle: l.driverLostItemsTileLede, onTap: () => context.push(Routes.lostItems)),
                    ],
                  ),
                SectionGroup(
                  title: l.preferences,
                  children: [
                    SettingsValueTile(icon: Icons.language_rounded, title: l.language, value: Localizations.localeOf(context).languageCode == 'am' ? 'አማርኛ' : 'English', onTap: () => context.push(Routes.language)),
                    SettingsValueTile(icon: Icons.dark_mode_rounded, title: l.appearance, value: themeLabel, onTap: () => context.push(Routes.appearance)),
                    SettingsTile(icon: Icons.notifications_rounded, title: l.notifications, onTap: () => context.push(Routes.notifications)),
                  ],
                ),
                SectionGroup(
                  title: l.safety,
                  children: [
                    SettingsTile(icon: Icons.emergency_rounded, iconTone: c.danger, title: l.emergencyContact, subtitle: ref.watch(emergencyContactProvider)?.name ?? l.notSet, onTap: () => context.push(Routes.safety)),
                  ],
                ),
                SectionGroup(
                  title: l.account,
                  children: [
                    SettingsTile(
                      icon: Icons.business_rounded,
                      title: l.organizations,
                      subtitle: orgs == null ? null : (orgs.orgs.isEmpty ? l.noOrganizations : orgs.orgs.map((o) => o.name).join(', ')),
                      badge: invites > 0 ? StatusPill('$invites', tone: Tone.amber) : null,
                      onTap: () => context.push(Routes.organizations),
                    ),
                    SettingsTile(icon: Icons.devices_rounded, title: l.sessions, onTap: () => context.push(Routes.sessions)),
                    if (deletion) SettingsTile(icon: Icons.delete_outline_rounded, title: l.deleteAccount, iconTone: c.muted, badge: comingSoon, onTap: () => context.push(Routes.deleteAccount)),
                  ],
                ),
                if (support) SectionGroup(title: l.support, children: [SettingsTile(icon: Icons.support_agent_rounded, title: l.support, subtitle: l.supportTileLede, onTap: () => context.push(Routes.support))]),
                SectionGroup(
                  children: [
                    SettingsTile(
                      icon: Icons.logout_rounded,
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
                  ],
                ),
                const SizedBox(height: 4),
                Center(child: Text(version == null ? '' : l.appVersion('${version.version}+${version.build}'), style: AnbessaType.caption.copyWith(color: c.faint))),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Who you are: the photo (a Hero into the profile), name, phone, rating · trips. Its own widget
/// so the rating and the trip count arriving rebuild only this part.
class _Header extends ConsumerWidget {
  const _Header({required this.session, required this.mode});
  final Session session;
  final AppMode mode;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final rating = ref.watch(myRatingProvider).value;
    final trips = ref.watch(tripCountProvider(mode == AppMode.driver ? 'driver' : 'rider')).value;
    return Semantics(
      button: true,
      hint: l.editProfileHint,
      child: InkWell(
        onTap: () => context.push(Routes.profile),
        borderRadius: BorderRadius.circular(AnbessaRadius.lg),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
          child: Row(
            children: [
              Hero(tag: meAvatarHeroTag, child: AvatarImage(src: session.profile.image, name: session.displayName, size: 72, ring: true)),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(session.displayName, style: AnbessaType.h1.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    Text(formatPhone(session.profile.phone), style: AnbessaType.body2.copyWith(color: c.muted, fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 6),
                    Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 6,
                      runSpacing: 2,
                      children: [
                        RatingSummary(average: rating?.average, count: rating?.count ?? 0, newLabel: '—'),
                        if (trips != null) ...[
                          ExcludeSemantics(child: Text('·', style: AnbessaType.body2.copyWith(color: c.faint))),
                          Text(trips.more ? l.tripsCountAtLeast(trips.count) : l.tripsCount(trips.count), style: AnbessaType.body2.copyWith(color: c.text2)),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, color: c.faint)),
            ],
          ),
        ),
      ),
    );
  }
}
