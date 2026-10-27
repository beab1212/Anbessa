// Every SharedPreferences key in one place, so nothing collides and the settings inventory in
// the README matches the code.

abstract final class PrefsKeys {
  static const locale = 'locale';
  static const themeMode = 'theme_mode';
  static const mode = 'mode';
  static const introSeen = 'intro_seen';
  static const recentPlaces = 'recent_places';
  static const lastPaymentMethod = 'last_payment_method';
  static const billingOrgId = 'billing_org_id';
  static const dismissedAnnouncements = 'dismissed_announcements';
  static const emergencyContact = 'emergency_contact';
  static const notifTrip = 'notif_trip';
  static const notifSound = 'notif_sound';
  static const notifVibrateOffer = 'notif_vibrate_offer';
  static const haptics = 'haptics';
  static const navBearing = 'nav_bearing';
  static const navApp = 'nav_app';
  static const keepAwake = 'keep_awake';
  static const navVoice = 'nav_voice';
  static const lastVehicleId = 'last_vehicle_id';
  static const clientConfig = 'client_config';
  static const mapMode = 'map_mode';
}
