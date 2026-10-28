// Account (both modes), the GoRide kit's p. 148 / 152: the logo, "Account" and ⋮ on top; a profile
// card (photo, name, phone, rating · trips; tap → Personal Info) with the driver's balance and
// "Top up"; then one card of rows with outline icons and chevrons (mode switch, Saved Addresses,
// Notifications, Payment Methods, Account & Security, App Appearance, Language, Emergency
// contact, Organizations, Help & Support, the driver's own rows) ending with a red Logout.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/session/session_controller.dart';
import '../bootstrap/gates.dart' show AnbessaLogo;
import '../config/client_config_provider.dart';
import '../driver/earnings/earnings_controller.dart';
import '../rider/history/history_screens.dart';
import '../rider/payments/payment_due_controller.dart';
import '../rider/trip/active_trip_controller.dart';
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

  Future<void> _signOut(BuildContext context, WidgetRef ref) async {
    final l = context.l10n;
    final yes = await showConfirmSheet(context, title: l.signOut, message: l.signOutConfirm, confirmLabel: l.accYesSignOut, cancelLabel: l.cancel, destructive: true);
    if (yes) await ref.read(sessionProvider.notifier).signOut();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final session = ref.watch(currentSessionProvider);
    final version = ref.watch(appVersionProvider).value;
    final support = ref.watch(featureProvider(Feature.support));
    final scheduled = ref.watch(featureProvider(Feature.scheduledRides));
    final orgs = ref.watch(organizationsProvider).value;
    final invites = orgs?.invitations.length ?? 0;
    if (session == null) return const SizedBox.shrink();
    final driver = mode == AppMode.driver;
        final language = Localizations.localeOf(context).languageCode == 'am' ? 'አማርኛ' : 'English';
    // the mode row: switch, or become a driver
    final (modeIcon, modeTitle, modeSub, modeTarget) = driver
        ? (Icons.hail_rounded, l.switchToRider, null, AppMode.rider)
        : session.canDrive
            ? (Icons.directions_car_outlined, l.switchToDriver, null, AppMode.driver)
            : (Icons.directions_car_outlined, l.becomeDriver, l.becomeDriverLede, AppMode.driver);

    final rows = <Widget>[
      AccountRow(icon: modeIcon, iconColor: c.accentText, title: modeTitle, subtitle: modeSub, onTap: () => ref.read(modeProvider.notifier).set(modeTarget)),
      if (!driver) ...[
        AccountRow(icon: Icons.location_on_outlined, title: l.accSavedAddresses, onTap: () => context.push(Routes.savedPlaces)),
        if (scheduled) AccountRow(icon: Icons.event_outlined, title: l.scheduledRides, onTap: () => context.push(Routes.scheduled)),
      ],
      if (driver) ...[
        AccountRow(icon: Icons.directions_car_outlined, title: l.vehicles, onTap: () => context.push(Routes.driverVehicles)),
        AccountRow(icon: Icons.navigation_outlined, title: l.navigation, onTap: () => context.push(Routes.navigationPrefs)),
        AccountRow(icon: Icons.account_balance_wallet_outlined, title: l.tabEarnings, onTap: () => context.go(Routes.driverEarnings)),
        if (support) AccountRow(icon: Icons.backpack_outlined, title: l.lostItems, subtitle: l.driverLostItemsTileLede, onTap: () => context.push(Routes.lostItems)),
      ],
      AccountRow(icon: Icons.notifications_none_rounded, title: l.notifications, onTap: () => context.push(Routes.notifications)),
      if (!driver) AccountRow(icon: Icons.credit_card_outlined, title: l.accPaymentMethods, onTap: () => context.push(Routes.paymentPrefs)),
      AccountRow(icon: Icons.shield_outlined, title: l.accAccountSecurity, onTap: () => context.push(Routes.security)),
      AccountRow(icon: Icons.remove_red_eye_outlined, title: l.accAppAppearance, onTap: () => context.push(Routes.appearance)),
      AccountRow(icon: Icons.language_rounded, title: l.language, value: language, onTap: () => context.push(Routes.language)),
      AccountRow(icon: Icons.emergency_outlined, iconColor: c.danger, title: l.emergencyContact, subtitle: ref.watch(emergencyContactProvider)?.name ?? l.notSet, onTap: () => context.push(Routes.safety)),
      AccountRow(
        icon: Icons.business_outlined,
        title: l.organizations,
        subtitle: orgs == null ? null : (orgs.orgs.isEmpty ? l.noOrganizations : orgs.orgs.map((o) => o.name).join(', ')),
        badge: invites > 0 ? StatusPill('$invites', tone: Tone.amber) : null,
        onTap: () => context.push(Routes.organizations),
      ),
      if (support) AccountRow(icon: Icons.help_outline_rounded, title: l.accHelpSupport, subtitle: l.supportTileLede, onTap: () => context.push(Routes.support)),
      AccountRow(icon: Icons.logout_rounded, iconColor: c.danger, title: l.signOut, titleColor: c.danger, chevron: false, onTap: () => _signOut(context, ref)),
    ];

    return Scaffold(
      backgroundColor: c.groupedPage,
      appBar: AppTopBar(
        leadingKind: TopBarLeading.none,
        leading: const AnbessaLogo(size: 30),
        title: l.accountTitle,
        background: c.groupedPage,
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert_rounded),
            tooltip: MaterialLocalizations.of(context).showMenuTooltip,
            onSelected: (v) => switch (v) {
              'mode' => ref.read(modeProvider.notifier).set(modeTarget),
              'profile' => context.push(Routes.profile),
              _ => _signOut(context, ref),
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'profile', child: _MenuRow(Icons.person_outline_rounded, l.accPersonalInfo)),
              PopupMenuItem(value: 'mode', child: _MenuRow(modeIcon, modeTitle)),
              PopupMenuItem(value: 'out', child: _MenuRow(Icons.logout_rounded, l.signOut, color: c.danger)),
            ],
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
        children: [
          _ProfileCard(session: session, mode: mode),
          const SizedBox(height: 16),
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Column(children: rows),
          ),
          const SizedBox(height: 16),
          Center(child: Text(version == null ? '' : l.appVersion('${version.version}+${version.build}'), style: AnbessaType.caption.copyWith(color: c.faint))),
        ],
      ),
    );
  }
}

class _MenuRow extends StatelessWidget {
  const _MenuRow(this.icon, this.label, {this.color});
  final IconData icon;
  final String label;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final c = color ?? context.colors.text;
    return Row(children: [Icon(icon, size: 20, color: c), const SizedBox(width: 12), Flexible(child: Text(label, style: AnbessaType.body.copyWith(color: c, fontWeight: FontWeight.w600)))]);
  }
}

/// A row of the account card: a plain outline icon (no circle, as the kit), the title (and a grey
/// line), a value or badge, and a chevron.
class AccountRow extends StatelessWidget {
  const AccountRow({super.key, required this.icon, required this.title, this.subtitle, this.value, this.badge, this.onTap, this.iconColor, this.titleColor, this.chevron = true});
  final IconData icon;
  final String title;
  final String? subtitle;
  /// a grey value before the chevron ("English", "System")
  final String? value;
  final Widget? badge;
  final VoidCallback? onTap;
  final Color? iconColor;
  final Color? titleColor;
  final bool chevron;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListRowTile(
      leading: ExcludeSemantics(child: Icon(icon, size: 24, color: iconColor ?? c.text)),
      title: title,
      subtitle: subtitle,
      titleColor: titleColor,
      padding: const EdgeInsets.symmetric(vertical: 9),
      trailing: value != null
          ? ConstrainedBox(constraints: const BoxConstraints(maxWidth: 110), child: Text(value!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.muted)))
          : badge,
      chevron: chevron,
      onTap: onTap,
    );
  }
}

/// Who you are: the photo (a Hero into Personal Info), name, phone, rating · trips; for drivers
/// the balance with "Top up". Its own widget so the rating, the trip count and the balance
/// arriving rebuild only this card.
class _ProfileCard extends ConsumerWidget {
  const _ProfileCard({required this.session, required this.mode});
  final Session session;
  final AppMode mode;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final driver = mode == AppMode.driver;
    final rating = ref.watch(myRatingProvider).value;
    final trips = ref.watch(tripCountProvider(driver ? 'driver' : 'rider')).value;
    final balance = driver && session.canDrive ? ref.watch(balanceProvider).value : null;
    final caption = AnbessaType.caption.copyWith(color: c.muted);
    return AppCard(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Column(
        children: [
          Semantics(
            button: true,
            hint: l.editProfileHint,
            child: InkWell(
              onTap: () => context.push(Routes.profile),
              borderRadius: BorderRadius.circular(AnbessaRadius.md),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Row(
                  children: [
                    Hero(tag: meAvatarHeroTag, child: AvatarImage(src: session.profile.image, name: session.displayName, size: 50)),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(session.displayName, style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 4),
                          Row(children: [
                            ExcludeSemantics(child: Icon(Icons.phone_outlined, size: 15, color: c.muted)),
                            const SizedBox(width: 6),
                            Flexible(child: Text(formatPhone(session.profile.phone), style: caption.copyWith(fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis)),
                          ]),
                          const SizedBox(height: 4),
                          Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            spacing: 6,
                            runSpacing: 2,
                            children: [
                              RatingSummary(average: rating?.average, count: rating?.count ?? 0, newLabel: '—', style: caption.copyWith(color: c.text2)),
                              if (trips != null) ...[
                                ExcludeSemantics(child: Text('·', style: caption)),
                                Text(trips.more ? l.tripsCountAtLeast(trips.count) : l.tripsCount(trips.count), style: caption.copyWith(color: c.text2)),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ),
                    ExcludeSemantics(child: Icon(Icons.chevron_right_rounded, color: c.text)),
                  ],
                ),
              ),
            ),
          ),
          if (balance != null) ...[
            Divider(height: 1, color: c.border),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Row(
                children: [
                  CircleIcon(Icons.account_balance_wallet_outlined, size: 48, color: c.accentText),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        MoneyText(balance.balanceMinor, locale: context.localeTag, style: AnbessaType.title.copyWith(color: balance.balanceMinor < 0 ? c.danger : c.text)),
                        const SizedBox(height: 2),
                        Text(l.accAvailableBalance, style: caption.copyWith(fontSize: 12), maxLines: 1, overflow: TextOverflow.ellipsis),
                      ],
                    ),
                  ),
                  PillButton(label: l.topUp, variant: PillVariant.outlineNeutral, compact: true, onPressed: () => context.push(Routes.driverTopUp)),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
