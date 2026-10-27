// Hand a destination to a navigation app for voice guidance.

import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

enum NavApp { google, waze, system }

/// Try the chosen app, then fall back down the list; returns false when nothing could open.
Future<bool> openExternalNavigation(double lat, double lng, {NavApp app = NavApp.system, String? label}) async {
  final name = Uri.encodeComponent(label ?? '');
  final candidates = <Uri>[
    if (app == NavApp.google) ...[
      if (defaultTargetPlatform == TargetPlatform.iOS) Uri.parse('comgooglemaps://?daddr=$lat,$lng&directionsmode=driving') else Uri.parse('google.navigation:q=$lat,$lng&mode=d'),
    ],
    if (app == NavApp.waze) Uri.parse('waze://?ll=$lat,$lng&navigate=yes'),
    if (defaultTargetPlatform == TargetPlatform.iOS) Uri.parse('maps://?daddr=$lat,$lng&dirflg=d') else Uri.parse('geo:$lat,$lng?q=$lat,$lng($name)'),
    Uri.parse('https://www.google.com/maps/dir/?api=1&destination=$lat,$lng&travelmode=driving'),
  ];
  for (final u in candidates) {
    try {
      if (await launchUrl(u, mode: LaunchMode.externalApplication)) return true;
    } catch (_) {}
  }
  return false;
}
