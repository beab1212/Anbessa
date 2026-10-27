// On-device settings: notification toggles (local categories; there is no server inbox yet), the
// emergency contact, navigation preferences and the default company for business rides.

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/network/providers.dart';
import '../../core/prefs_keys.dart';
import '../../core/session/session_controller.dart';
import '../maps/nav/external_nav.dart';

@immutable
class NotificationPrefs {
  const NotificationPrefs({this.trip = true, this.promo = true, this.sound = true});
  final bool trip;
  final bool promo;
  final bool sound;
  NotificationPrefs copyWith({bool? trip, bool? promo, bool? sound}) => NotificationPrefs(trip: trip ?? this.trip, promo: promo ?? this.promo, sound: sound ?? this.sound);
}

class NotificationPrefsController extends Notifier<NotificationPrefs> {
  @override
  NotificationPrefs build() {
    final p = ref.watch(prefsProvider);
    return NotificationPrefs(trip: p.getBool(PrefsKeys.notifTrip) ?? true, promo: p.getBool(PrefsKeys.notifPromo) ?? true, sound: p.getBool(PrefsKeys.notifSound) ?? true);
  }

  Future<void> set({bool? trip, bool? promo, bool? sound}) async {
    state = state.copyWith(trip: trip, promo: promo, sound: sound);
    final p = ref.read(prefsProvider);
    await p.setBool(PrefsKeys.notifTrip, state.trip);
    await p.setBool(PrefsKeys.notifPromo, state.promo);
    await p.setBool(PrefsKeys.notifSound, state.sound);
  }
}

final notificationPrefsProvider = NotifierProvider<NotificationPrefsController, NotificationPrefs>(NotificationPrefsController.new);

@immutable
class EmergencyContact {
  const EmergencyContact({required this.name, required this.phone});
  final String name;
  final String phone;
}

class EmergencyContactController extends Notifier<EmergencyContact?> {
  @override
  EmergencyContact? build() {
    final raw = ref.watch(prefsProvider).getString(PrefsKeys.emergencyContact);
    if (raw == null || !raw.contains('|')) return null;
    final i = raw.indexOf('|');
    return EmergencyContact(name: raw.substring(0, i), phone: raw.substring(i + 1));
  }

  Future<void> set(EmergencyContact? c) async {
    state = c;
    final p = ref.read(prefsProvider);
    if (c == null) {
      await p.remove(PrefsKeys.emergencyContact);
    } else {
      await p.setString(PrefsKeys.emergencyContact, '${c.name}|${c.phone}');
    }
  }
}

final emergencyContactProvider = NotifierProvider<EmergencyContactController, EmergencyContact?>(EmergencyContactController.new);

@immutable
class NavPrefs {
  const NavPrefs({this.bearing = true, this.app = NavApp.system, this.keepAwake = true, this.ask = true});
  final bool bearing;
  final NavApp app;
  final bool keepAwake;
  /// ask which app every time (else open [app] straight away)
  final bool ask;
  NavPrefs copyWith({bool? bearing, NavApp? app, bool? keepAwake, bool? ask}) => NavPrefs(bearing: bearing ?? this.bearing, app: app ?? this.app, keepAwake: keepAwake ?? this.keepAwake, ask: ask ?? this.ask);
}

class NavPrefsController extends Notifier<NavPrefs> {
  @override
  NavPrefs build() {
    final p = ref.watch(prefsProvider);
    final app = p.getString(PrefsKeys.navApp);
    return NavPrefs(
      bearing: p.getBool(PrefsKeys.navBearing) ?? true,
      app: NavApp.values.where((a) => a.name == app).firstOrNull ?? NavApp.system,
      ask: app == null || app == 'ask',
      keepAwake: p.getBool(PrefsKeys.keepAwake) ?? true,
    );
  }

  Future<void> set({bool? bearing, NavApp? app, bool? ask, bool? keepAwake}) async {
    state = state.copyWith(bearing: bearing, app: app, ask: ask, keepAwake: keepAwake);
    final p = ref.read(prefsProvider);
    await p.setBool(PrefsKeys.navBearing, state.bearing);
    await p.setString(PrefsKeys.navApp, state.ask ? 'ask' : state.app.name);
    await p.setBool(PrefsKeys.keepAwake, state.keepAwake);
  }
}

final navPrefsProvider = NotifierProvider<NavPrefsController, NavPrefs>(NavPrefsController.new);

/// My organisations and pending invitations.
class OrganizationsController extends AsyncNotifier<({List<Organization> orgs, List<OrgInvitation> invitations})> {
  @override
  Future<({List<Organization> orgs, List<OrgInvitation> invitations})> build() async {
    if (ref.watch(currentSessionProvider) == null) return (orgs: const <Organization>[], invitations: const <OrgInvitation>[]);
    final api = ref.read(organizationsApiProvider);
    final orgs = await api.mine();
    List<OrgInvitation> invites = const [];
    try {
      invites = (await api.invitations()).where((i) => i.isPending).toList();
    } catch (_) {}
    return (orgs: orgs, invitations: invites);
  }

  Future<void> refresh() async => state = AsyncData(await build());

  Future<void> answer(OrgInvitation i, {required bool accept}) async {
    final api = ref.read(organizationsApiProvider);
    if (accept) {
      await api.accept(i.id);
      // the new membership shows up in the next token's roles
      await ref.read(sessionProvider.notifier).refreshClaims();
    } else {
      await api.reject(i.id);
    }
    await refresh();
  }
}

final organizationsProvider = AsyncNotifierProvider<OrganizationsController, ({List<Organization> orgs, List<OrgInvitation> invitations})>(OrganizationsController.new);

/// The company billed by default for business rides (prefs).
class BillingOrgController extends Notifier<String?> {
  @override
  String? build() => ref.watch(prefsProvider).getString(PrefsKeys.billingOrgId);
  Future<void> set(String? id) async {
    state = id;
    final p = ref.read(prefsProvider);
    if (id == null) {
      await p.remove(PrefsKeys.billingOrgId);
    } else {
      await p.setString(PrefsKeys.billingOrgId, id);
    }
  }
}

final billingOrgProvider = NotifierProvider<BillingOrgController, String?>(BillingOrgController.new);
