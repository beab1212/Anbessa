// A person's picture: a data URL (profile photos are stored that way), an https URL, or
// initials in amber when there's none.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';

class AvatarImage extends StatelessWidget {
  const AvatarImage({super.key, this.src, required this.name, this.size = 44, this.ring = false});
  final String? src;
  final String name;
  final double size;
  /// an amber ring (the driver on the trip card)
  final bool ring;

  /// The app can install a cached network image builder here.
  static Widget Function(String url, double size)? networkBuilder;

  static Uint8List? decodeDataUrl(String src) {
    if (!src.startsWith('data:')) return null;
    final comma = src.indexOf(',');
    if (comma < 0) return null;
    try {
      return base64Decode(src.substring(comma + 1));
    } catch (_) {
      return null;
    }
  }

  static String initialsOf(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty && !RegExp(r'^[+\d]').hasMatch(p)).toList();
    if (parts.isEmpty) return '';
    return parts.length == 1 ? parts.first.characters.first.toUpperCase() : (parts.first.characters.first + parts.last.characters.first).toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget inner;
    final s = src;
    final bytes = s == null ? null : decodeDataUrl(s);
    if (bytes != null) {
      inner = Image.memory(bytes, width: size, height: size, fit: BoxFit.cover, gaplessPlayback: true);
    } else if (s != null && s.startsWith('http')) {
      inner = networkBuilder?.call(s, size) ?? Image.network(s, width: size, height: size, fit: BoxFit.cover, errorBuilder: (_, _, _) => _initials(c));
    } else {
      inner = _initials(c);
    }
    return Semantics(
      label: name,
      image: true,
      child: Container(
        width: size,
        height: size,
        padding: ring ? const EdgeInsets.all(2) : EdgeInsets.zero,
        decoration: ring ? BoxDecoration(shape: BoxShape.circle, border: Border.all(color: c.accent, width: 2)) : null,
        child: ClipOval(child: inner),
      ),
    );
  }

  Widget _initials(AnbessaColors c) {
    final i = initialsOf(name);
    return Container(
      color: c.accentSoft,
      alignment: Alignment.center,
      child: i.isEmpty ? Icon(Icons.person, size: size * 0.55, color: c.accentStrong) : Text(i, style: TextStyle(fontSize: size * 0.38, fontWeight: FontWeight.w700, color: c.accentStrong)),
    );
  }
}
