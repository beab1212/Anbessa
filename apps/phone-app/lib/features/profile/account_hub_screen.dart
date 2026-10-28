// Account (both modes), the GoRide kit's p. 148 / 152 in a calmer layout: the logo, "Account" and
// ⋮ on top; a roomy profile card (photo, name, phone, rating · trips; tap → Personal Info) with
// the driver's balance and "Top up"; then a few small cards under quiet section titles: Ride (or
// Driving: the mode switch and the mode's own rows), Preferences (Notifications, App Appearance,
// Language), Safety & support (Emergency contact, Help & Support) and Account (Account & Security,
// Organizations). Rows are at least 60 px with a soft tinted 40 px icon circle; hairlines start
// past the icon. Logout is its own quiet card at the bottom, above the version.

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

    final modeRow = AccountRow(icon: modeIcon, tone: c.accentText, title: modeTitle, subtitle: modeSub, onTap: () => ref.read(modeProvider.notifier).set(modeTarget));
    final sections = <(String, List<Widget>)>[
      if (!driver)
        (l.relaxSectionRide, [
          modeRow,
          AccountRow(icon: Icons.location_on_outlined, title: l.accSavedAddresses, onTap: () => context.push(Routes.savedPlaces)),
          if (scheduled) AccountRow(icon: Icons.event_outlined, title: l.scheduledRides, onTap: () => context.push(Routes.scheduled)),
          AccountRow(icon: Icons.credit_card_outlined, title: l.accPaymentMethods, onTap: () => context.push(Routes.paymentPrefs)),
        ])
      else
        (l.relaxSectionDriving, [
          modeRow,
          AccountRow(icon: Icons.directions_car_outlined, title: l.vehicles, onTap: () => context.push(Routes.driverVehicles)),
          AccountRow(icon: Icons.navigation_outlined, title: l.navigation, onTap: () => context.push(Routes.navigationPrefs)),
          AccountRow(icon: Icons.account_balance_wallet_outlined, title: l.tabEarnings, onTap: () => context.go(Routes.driverEarnings)),
          if (support) AccountRow(icon: Icons.backpack_outlined, title: l.lostItems, subtitle: l.driverLostItemsTileLede, onTap: () => context.push(Routes.lostItems)),
        ]),
      (l.relaxSectionPreferences, [
        AccountRow(icon: Icons.notifications_none_rounded, title: l.notifications, onTap: () => context.push(Routes.notifications)),
        AccountRow(icon: Icons.remove_red_eye_outlined, title: l.accAppAppearance, onTap: () => context.push(Routes.appearance)),
        AccountRow(icon: Icons.language_rounded, title: l.language, value: language, onTap: () => context.push(Routes.language)),
      ]),
      (l.relaxSectionSafety, [
        AccountRow(icon: Icons.emergency_outlined, tone: c.danger, title: l.emergencyContact, subtitle: ref.watch(emergencyContactProvider)?.name ?? l.notSet, onTap: () => context.push(Routes.safety)),
        if (support) AccountRow(icon: Icons.help_outline_rounded, title: l.accHelpSupport, subtitle: l.supportTileLede, onTap: () => context.push(Routes.support)),
      ]),
      (l.relaxSectionAccount, [
        AccountRow(icon: Icons.shield_outlined, title: l.accAccountSecurity, onTap: () => context.push(Routes.security)),
        AccountRow(
          icon: Icons.business_outlined,
          title: l.organizations,
          subtitle: orgs == null ? null : (orgs.orgs.isEmpty ? l.noOrganizations : orgs.orgs.map((o) => o.name).join(', ')),
          badge: invites > 0 ? StatusPill('$invites', tone: Tone.amber) : null,
          onTap: () => context.push(Routes.organizations),
        ),
      ]),
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
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 12, AnbessaSpace.page, 32),
        children: [
          _ProfileCard(session: session, mode: mode),
          for (final (title, rows) in sections) AccountSection(title: title, children: rows),
          const SizedBox(height: 24),
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
            child: AccountRow(icon: Icons.logout_rounded, tone: c.danger, title: l.signOut, titleColor: c.danger, chevron: false, onTap: () => _signOut(context, ref)),
          ),
          const SizedBox(height: 24),
          Center(child: Text(version == null ? '' : l.appVersion('${version.version}+${version.build}'), style: AnbessaType.caption.copyWith(color: c.faint))),
        ],
      ),
    );
  }
}

/// A quiet section of the account page: a small muted title over a card of rows, hairlines
/// between them starting past the icon.
class AccountSection extends StatelessWidget {
  const AccountSection({super.key, required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
            child: Semantics(header: true, child: Text(title, style: AnbessaType.label.copyWith(color: c.muted, fontWeight: FontWeight.w600, letterSpacing: 0.3))),
          ),
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
            child: Column(
              children: [
                for (final (i, row) in children.indexed) ...[
                  if (i > 0) Divider(height: 1, thickness: 1, indent: AccountRow.iconSize + AccountRow.gap, color: c.border.withValues(alpha: c.isDark ? 0.7 : 0.8)),
                  row,
                ],
              ],
            ),
          ),
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

/// A row of an account card: the icon in a soft tinted 40 px circle, the title (and a grey
/// line), a value or badge, and a chevron; at least 60 px tall.
class AccountRow extends StatelessWidget {
  const AccountRow({super.key, required this.icon, required this.title, this.subtitle, this.value, this.badge, this.onTap, this.tone, this.titleColor, this.chevron = true});
  static const iconSize = 40.0;
  static const gap = 14.0;
  static const minHeight = 60.0;
  final IconData icon;
  final String title;
  final String? subtitle;
  /// a grey value before the chevron ("English", "System")
  final String? value;
  final Widget? badge;
  final VoidCallback? onTap;
  /// tints the icon circle (amber for the mode switch, red for emergency and logout); neutral otherwise
  final Color? tone;
  final Color? titleColor;
  final bool chevron;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fill = tone == null ? (c.isDark ? c.border.withValues(alpha: 0.7) : c.canvas) : tone!.withValues(alpha: c.isDark ? 0.18 : 0.1);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: minHeight),
      child: ListRowTile(
        leading: ExcludeSemantics(
          child: Container(
            width: iconSize,
            height: iconSize,
            decoration: BoxDecoration(shape: BoxShape.circle, color: fill),
            child: Icon(icon, size: 20, color: tone ?? c.text2),
          ),
        ),
        title: title,
        subtitle: subtitle,
        titleColor: titleColor,
        padding: const EdgeInsets.symmetric(vertical: 10),
        trailing: value != null
            ? ConstrainedBox(constraints: const BoxConstraints(maxWidth: 110), child: Text(value!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body2.copyWith(color: c.muted)))
            : badge,
        chevron: chevron,
        onTap: onTap,
      ),
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
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
      child: Column(
        children: [
          Semantics(
            button: true,
            hint: l.editProfileHint,
            child: InkWell(
              onTap: () => context.push(Routes.profile),
              borderRadius: BorderRadius.circular(AnbessaRadius.md),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Row(
                  children: [
                    Hero(tag: meAvatarHeroTag, child: AvatarImage(src: session.profile.image, name: session.displayName, size: 64)),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(session.displayName, style: AnbessaType.title.copyWith(color: c.text, fontSize: 18), maxLines: 1, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 6),
                          Row(children: [
                            ExcludeSemantics(child: Icon(Icons.phone_outlined, size: 15, color: c.muted)),
                            const SizedBox(width: 6),
                            Flexible(child: Text(formatPhone(session.profile.phone), style: caption.copyWith(fontFeatures: AnbessaType.tabular), maxLines: 1, overflow: TextOverflow.ellipsis)),
                          ]),
                          const SizedBox(height: 6),
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
            Divider(height: 1, color: c.border.withValues(alpha: 0.8)),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
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
