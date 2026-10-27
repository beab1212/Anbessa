// Words and numbers for guidance: distances rounded the way a driver reads them ("Now", "50 m",
// "850 m", "1.2 km"), roundabout exits ("Take the 2nd exit"), and short spoken instructions.
// `km()` stays as it is for the rest of the app (trip lengths, receipts).

import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import 'maneuver_icons.dart';

/// Below this the maneuver is "Now".
const navNowMeters = 15;

/// The distance rounded for guidance: 10 m steps below 100 m, 50 m steps below 1 km, then km
/// with one decimal (no decimal from 10 km). Null when it is "Now".
({int? meters, String? km}) navRound(int meters) {
  if (meters < navNowMeters) return (meters: null, km: null);
  if (meters < 100) return (meters: ((meters / 10).round() * 10).clamp(10, 100), km: null);
  if (meters < 1000) {
    final r = (meters / 50).round() * 50;
    if (r < 1000) return (meters: r, km: null);
  }
  final k = meters / 1000;
  return (meters: null, km: k >= 10 ? k.round().toString() : k.toStringAsFixed(1));
}

/// "Now", "50 m", "850 m", "1.2 km".
String navDistance(AppLocalizations l, int meters) {
  final r = navRound(meters);
  if (r.meters != null) return l.navMeters('${r.meters}');
  if (r.km != null) return l.navKm(r.km!);
  return l.navNow;
}

/// The same distance for the voice: "200 metres", "1.2 kilometres" (null for "Now").
String? navSpokenDistance(AppLocalizations l, int meters) {
  final r = navRound(meters);
  if (r.meters != null) return l.navVoiceMeters('${r.meters}');
  if (r.km != null) return l.navVoiceKm(r.km!);
  return null;
}

/// "1st", "2nd", "3rd", "11th" in English; the bare number elsewhere (the Amharic sentence adds
/// its own ordinal ending).
String navOrdinal(AppLocalizations l, int n) {
  if (!l.localeName.startsWith('en')) return '$n';
  final teen = n % 100 >= 11 && n % 100 <= 13;
  final suffix = teen ? 'th' : switch (n % 10) { 1 => 'st', 2 => 'nd', 3 => 'rd', _ => 'th' };
  return '$n$suffix';
}

bool _isRoundabout(RouteStep s) => s.type == 'roundabout' || s.type == 'rotary' || s.type == 'roundabout turn';

/// The instruction for a step on the banner: the street name when there is one, the exit number
/// at a roundabout.
String navInstruction(AppLocalizations l, RouteStep s) {
  final exit = s.exit;
  if (_isRoundabout(s) && exit != null && exit > 0) {
    return s.name.isEmpty ? l.navRoundaboutExitShort(navOrdinal(l, exit)) : l.navRoundaboutExit(navOrdinal(l, exit), s.name);
  }
  if (s.name.isEmpty) return navShortInstruction(l, s);
  return maneuverLabel(l, maneuverKey(s), s.name);
}

/// The instruction without the street ("Turn left", "Take the 2nd exit").
String navShortInstruction(AppLocalizations l, RouteStep s) {
  final exit = s.exit;
  if (_isRoundabout(s) && exit != null && exit > 0) return l.navRoundaboutExitShort(navOrdinal(l, exit));
  return switch (maneuverKey(s)) {
    'depart' => l.maneuverDepart,
    'arrive' => l.navShortArrive,
    'left' => l.navShortLeft,
    'right' => l.navShortRight,
    'slightLeft' => l.navShortSlightLeft,
    'slightRight' => l.navShortSlightRight,
    'sharpLeft' => l.navShortSharpLeft,
    'sharpRight' => l.navShortSharpRight,
    'uturn' => l.maneuverUturn,
    'roundabout' => l.maneuverRoundabout,
    'exitRoundabout' => l.navShortExitRoundabout,
    'merge' => l.navShortMerge,
    'onRamp' => l.navShortOnRamp,
    'offRamp' => l.navShortOffRamp,
    'forkLeft' => l.maneuverForkLeft,
    'forkRight' => l.maneuverForkRight,
    _ => l.navShortStraight,
  };
}
