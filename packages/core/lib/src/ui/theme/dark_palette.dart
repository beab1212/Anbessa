// The dark palette: deep navy surfaces, amber stays the accent, text contrast ≥ 4.5:1 on every
// surface (theme_test.dart checks it).

import 'package:flutter/material.dart';
import 'anbessa_theme.dart';

const anbessaDark = AnbessaColors(
  canvas: Color(0xFF0B1220),
  surface: Color(0xFF111A2B),
  surface2: Color(0xFF172238),
  border: Color(0xFF243049),
  borderStrong: Color(0xFF34425E),
  text: Color(0xFFE6EAF2),
  text2: Color(0xFFB4BCCB),
  muted: Color(0xFF8A94A6),
  faint: Color(0xFF5E6879),
  accent: Color(0xFFF59E0B),
  accentStrong: Color(0xFFFBBF24),
  accentSoft: Color(0x33F59E0B),
  success: Color(0xFF4ADE80),
  successSoft: Color(0x2922C55E),
  warning: Color(0xFFFBBF24),
  warningSoft: Color(0x29F59E0B),
  danger: Color(0xFFF87171),
  dangerSoft: Color(0x29EF4444),
  info: Color(0xFF60A5FA),
  infoSoft: Color(0x293B82F6),
);
