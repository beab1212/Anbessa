// The dark palette: warm charcoal surfaces (not navy), paper-white ink, the same amber. Text
// contrast >= 4.5:1 on every surface (theme_test.dart checks it).

import 'package:flutter/material.dart';
import 'anbessa_theme.dart';

const anbessaDark = AnbessaColors(
  canvas: Color(0xFF111214),
  surface: Color(0xFF1A1C1F),
  surface2: Color(0xFF222428),
  border: Color(0xFF2F3237),
  borderStrong: Color(0xFF45494F),
  text: Color(0xFFF3F1EC),
  text2: Color(0xFFCAC7C0),
  muted: Color(0xFF9E9B93),
  faint: Color(0xFF6E6B65),
  accent: Color(0xFFFFB300),
  accentStrong: Color(0xFFFFC53D),
  accentSoft: Color(0x2EFFB300),
  success: Color(0xFF45C99A),
  successSoft: Color(0x2645C99A),
  warning: Color(0xFFFFC53D),
  warningSoft: Color(0x26FFB300),
  danger: Color(0xFFFF6B6B),
  dangerSoft: Color(0x26FF6B6B),
  info: Color(0xFF7AA7FF),
  infoSoft: Color(0x267AA7FF),
);
