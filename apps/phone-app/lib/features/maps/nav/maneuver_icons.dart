// An icon for each OSRM maneuver (type + modifier).

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';

/// The maneuver's icon, with the exit number in a small badge at a roundabout.
class ManeuverGlyph extends StatelessWidget {
  const ManeuverGlyph({super.key, required this.step, this.size = 40, this.color});
  final RouteStep step;
  final double size;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final exit = step.exit;
    final roundabout = step.type == 'roundabout' || step.type == 'rotary' || step.type == 'roundabout turn';
    final icon = Icon(maneuverIcon(step), size: size, color: color ?? c.text);
    if (!roundabout || exit == null || exit <= 0) return icon;
    final badge = size * 0.42;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          icon,
          Positioned(
            right: -badge * 0.25,
            bottom: -badge * 0.15,
            child: Container(
              width: badge,
              height: badge,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: c.text, shape: BoxShape.circle, border: Border.all(color: c.surface, width: 1.5)),
              child: Text('$exit', textScaler: TextScaler.noScaling, style: TextStyle(fontSize: badge * 0.62, height: 1, fontWeight: FontWeight.w800, color: c.surface)),
            ),
          ),
        ],
      ),
    );
  }
}

IconData maneuverIcon(RouteStep s) {
  final m = s.modifier ?? '';
  switch (s.type) {
    case 'depart':
      return Icons.trip_origin;
    case 'arrive':
      return Icons.flag_rounded;
    case 'roundabout' || 'rotary' || 'roundabout turn':
      // traffic keeps right in Ethiopia: anticlockwise; a right exit is the short way round
      return m.contains('right') ? Icons.roundabout_right : Icons.roundabout_left;
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
