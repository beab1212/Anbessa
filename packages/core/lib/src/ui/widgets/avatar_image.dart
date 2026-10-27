// A person's picture: a data URL (profile photos are stored that way), an https URL, or
// initials in amber when there's none. Decoded data URLs are kept in a small LRU cache keyed by
// the string's hash, so a rebuild neither base64-decodes again nor hands Flutter a new
// ImageProvider (the same MemoryImage is an ImageCache hit: the JPEG is not decoded again).

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';

class AvatarImage extends StatelessWidget {
  const AvatarImage({super.key, this.src, required this.name, this.size = 44, this.ring = false});
  final String? src;
  final String name;
  final double size;
  /// an amber ring (the driver on the trip card)
  final bool ring;

  /// The app installs a cached network image builder here once at start (the phone app uses
  /// cached_network_image); core itself stays free of that dependency. [fallback] is the
  /// initials, for when the download fails. Null: `Image.network`.
  static Widget Function(String url, double size, Widget fallback)? networkBuilder;

  /// How many decoded pictures the cache keeps (profile photos are ~10–48 KB each).
  static const cacheCapacity = 32;
  static final _cache = <int, ({String src, MemoryImage image})>{}; // insertion-ordered: oldest first

  /// The picture of a data URL, decoded once and kept (least recently used out first). Null when
  /// [src] isn't a valid data URL.
  static MemoryImage? memoryImageOf(String src) {
    if (!src.startsWith('data:')) return null;
    final key = Object.hash(src.length, src.hashCode);
    final hit = _cache.remove(key);
    if (hit != null && hit.src == src) {
      _cache[key] = hit; // most recently used last
      return hit.image;
    }
    final bytes = decodeDataUrl(src);
    if (bytes == null) return null;
    final image = MemoryImage(bytes);
    _cache[key] = (src: src, image: image);
    while (_cache.length > cacheCapacity) {
      _cache.remove(_cache.keys.first);
    }
    return image;
  }

  /// How many pictures are cached (for tests).
  @visibleForTesting
  static int get cachedCount => _cache.length;

  @visibleForTesting
  static void clearCache() => _cache.clear();

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
    final memory = s == null ? null : memoryImageOf(s);
    if (memory != null) {
      inner = Image(image: memory, width: size, height: size, fit: BoxFit.cover, gaplessPlayback: true, errorBuilder: (_, _, _) => _initials(c));
    } else if (s != null && s.startsWith('http')) {
      final b = networkBuilder;
      inner = b != null ? b(s, size, _initials(c)) : Image.network(s, width: size, height: size, fit: BoxFit.cover, errorBuilder: (_, _, _) => _initials(c));
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
