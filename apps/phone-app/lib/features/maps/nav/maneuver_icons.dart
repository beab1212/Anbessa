// An icon for each OSRM maneuver (type + modifier).

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

IconData maneuverIcon(RouteStep s) {
  final m = s.modifier ?? '';
  switch (s.type) {
    case 'depart':
      return Icons.trip_origin;
    case 'arrive':
      return Icons.flag_rounded;
    case 'roundabout' || 'rotary' || 'roundabout turn':
      return Icons.roundabout_right;
    case 'exit roundabout' || 'exit rotary':
      return Icons.roundabout_left;
    case 'merge':
      return Icons.merge_rounded;
    case 'on ramp':
      return Icons.ramp_right;
    case 'off ramp':
      return Icons.ramp_left;
    case 'fork':
      return m.contains('left') ? Icons.fork_left : Icons.fork_right;
    default:
      break;
  }
  return switch (m) {
    'uturn' => Icons.u_turn_left,
    'sharp left' => Icons.turn_sharp_left,
    'left' => Icons.turn_left,
    'slight left' => Icons.turn_slight_left,
    'sharp right' => Icons.turn_sharp_right,
    'right' => Icons.turn_right,
    'slight right' => Icons.turn_slight_right,
    _ => Icons.straight,
  };
}

/// A short description key for the step, for the app's localisation ("Turn left", "Continue").
String maneuverKey(RouteStep s) {
  final m = s.modifier ?? '';
  return switch (s.type) {
    'depart' => 'depart',
    'arrive' => 'arrive',
    'roundabout' || 'rotary' || 'roundabout turn' => 'roundabout',
    'exit roundabout' || 'exit rotary' => 'exitRoundabout',
    'merge' => 'merge',
    'on ramp' => 'onRamp',
    'off ramp' => 'offRamp',
    'fork' => m.contains('left') ? 'forkLeft' : 'forkRight',
    _ => switch (m) {
        'uturn' => 'uturn',
        'sharp left' => 'sharpLeft',
        'left' => 'left',
        'slight left' => 'slightLeft',
        'sharp right' => 'sharpRight',
        'right' => 'right',
        'slight right' => 'slightRight',
        _ => 'straight',
      },
  };
}
