// The map (flutter_map, raster tiles): fits to a city or a set of points, draws pickup/drop-off
// pins, the driver's car (rotated by heading, grey when stale) and a dashed straight line between
// points. Quotes carry no route geometry yet, so the line is straight; `line` takes any polyline.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/config/env.dart';
import '../../core/state.dart';
import '../config/client_config_provider.dart';

const _osmTiles = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/// Tiles failed to load (the self-hosted stack is down, or no network).
final mapTilesDownProvider = valueProvider<bool>(false);

class AnbessaMap extends ConsumerStatefulWidget {
  const AnbessaMap({
    super.key,
    this.fit = const [],
    this.center,
    this.zoom = 13,
    this.pickup,
    this.dropoff,
    this.driver,
    this.me,
    this.line = const [],
    this.onTap,
    this.onMove,
    this.controller,
    this.padding = const EdgeInsets.all(48),
    this.interactive = true,
    this.children = const [],
  });

  /// Points to keep in view (padding applied). Empty: [center] or the city.
  final List<LatLng> fit;
  final LatLng? center;
  final double zoom;
  final LatLng? pickup;
  final LatLng? dropoff;
  final DriverMarkerData? driver;
  /// the person's own position (rider blue dot, driver car)
  final LatLng? me;
  final List<LatLng> line;
  final void Function(LatLng)? onTap;
  /// the map centre after the person dragged it (drag-to-pick)
  final void Function(LatLng)? onMove;
  final MapController? controller;
  final EdgeInsets padding;
  final bool interactive;
  final List<Widget> children;

  @override
  ConsumerState<AnbessaMap> createState() => _AnbessaMapState();
}

class _AnbessaMapState extends ConsumerState<AnbessaMap> {
  late final MapController _ctrl = widget.controller ?? MapController();
  List<LatLng> _lastFit = const [];
  Timer? _moveDebounce;

  @override
  void didUpdateWidget(covariant AnbessaMap old) {
    super.didUpdateWidget(old);
    if (widget.fit.isNotEmpty && !_sameFit(widget.fit, _lastFit)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _fitTo(widget.fit));
    }
  }

  bool _sameFit(List<LatLng> a, List<LatLng> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if ((a[i].latitude - b[i].latitude).abs() > 1e-4 || (a[i].longitude - b[i].longitude).abs() > 1e-4) return false;
    }
    return true;
  }

  void _fitTo(List<LatLng> pts) {
    if (!mounted || pts.isEmpty) return;
    _lastFit = List.of(pts);
    if (pts.length == 1) {
      _ctrl.move(pts.first, 15);
      return;
    }
    _ctrl.fitCamera(CameraFit.bounds(bounds: LatLngBounds.fromPoints(pts), padding: widget.padding, maxZoom: 16));
  }

  @override
  void dispose() {
    _moveDebounce?.cancel();
    if (widget.controller == null) _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final city = ref.watch(currentCityProvider);
    final initial = widget.center ?? (widget.fit.isNotEmpty ? widget.fit.first : LatLng(city.bbox.centerLat, city.bbox.centerLng));
    final tiles = Env.tileUrl.isEmpty ? _osmTiles : Env.tileUrl;
    return FlutterMap(
      mapController: _ctrl,
      options: MapOptions(
        initialCenter: initial,
        initialZoom: widget.zoom,
        minZoom: 9,
        maxZoom: 18,
        interactionOptions: InteractionOptions(flags: widget.interactive ? InteractiveFlag.all & ~InteractiveFlag.rotate : InteractiveFlag.none),
        onTap: widget.onTap == null ? null : (_, p) => widget.onTap!(p),
        onMapEvent: widget.onMove == null
            ? null
            : (e) {
                if (e is MapEventMoveEnd || e is MapEventFlingAnimationEnd) {
                  _moveDebounce?.cancel();
                  _moveDebounce = Timer(const Duration(milliseconds: 250), () => widget.onMove!(_ctrl.camera.center));
                }
              },
        onMapReady: () {
          if (widget.fit.isNotEmpty) _fitTo(widget.fit);
        },
        backgroundColor: c.canvas,
      ),
      children: [
        TileLayer(
          urlTemplate: tiles,
          userAgentPackageName: 'com.anbessa.phone_app',
          maxNativeZoom: 18,
          errorTileCallback: (_, _, _) => ref.read(mapTilesDownProvider.notifier).set(true),
        ),
        if (widget.line.length >= 2)
          PolylineLayer(polylines: [Polyline(points: widget.line, color: c.text, strokeWidth: 3, pattern: const StrokePattern.dotted(spacingFactor: 2.5))]),
        MarkerLayer(
          markers: [
            if (widget.me != null) Marker(point: widget.me!, width: 22, height: 22, child: const _MeDot()),
            if (widget.pickup != null) Marker(point: widget.pickup!, width: 40, height: 48, alignment: Alignment.topCenter, child: const PinMarker(tone: PinTone.amber)),
            if (widget.dropoff != null) Marker(point: widget.dropoff!, width: 40, height: 48, alignment: Alignment.topCenter, child: const PinMarker(tone: PinTone.ink)),
            if (widget.driver != null) Marker(point: widget.driver!.position, width: 44, height: 44, child: DriverMarker(data: widget.driver!)),
          ],
        ),
        ...widget.children,
        RichAttributionWidget(alignment: AttributionAlignment.bottomLeft, showFlutterMapAttribution: false, attributions: [TextSourceAttribution(Env.tileAttribution)]),
      ],
    );
  }
}

enum PinTone { amber, ink }

/// A pin whose tip is the point (align the marker to the top).
class PinMarker extends StatelessWidget {
  const PinMarker({super.key, required this.tone});
  final PinTone tone;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = tone == PinTone.amber ? c.accent : c.text;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 20,
          height: 20,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3), boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 4, offset: Offset(0, 2))]),
        ),
        Container(width: 2, height: 14, color: color),
        Container(width: 6, height: 3, decoration: BoxDecoration(color: const Color(0x44000000), borderRadius: BorderRadius.circular(3))),
      ],
    );
  }
}

class _MeDot extends StatelessWidget {
  const _MeDot();
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(decoration: BoxDecoration(color: c.info, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3), boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 4)]));
  }
}

@immutable
class DriverMarkerData {
  const DriverMarkerData({required this.position, this.heading, required this.stale, this.onTrip = true});
  final LatLng position;
  final double? heading;
  /// no ping for 20 s
  final bool stale;
  final bool onTrip;
}

/// The car: a rotated glyph, amber on a trip, grey when stale.
class DriverMarker extends StatelessWidget {
  const DriverMarker({super.key, required this.data});
  final DriverMarkerData data;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = data.stale ? c.faint : (data.onTrip ? c.accent : c.success);
    return Semantics(
      label: 'driver',
      child: Transform.rotate(
        angle: (data.heading ?? 0) * 3.14159265 / 180,
        child: Container(
          decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3), boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 5, offset: Offset(0, 2))]),
          child: const Icon(Icons.navigation, color: Colors.white, size: 22),
        ),
      ),
    );
  }
}

/// Something at the map centre while dragging to pick a place.
class CenterPin extends StatelessWidget {
  const CenterPin({super.key, this.tone = PinTone.amber});
  final PinTone tone;
  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: Center(child: Padding(padding: const EdgeInsets.only(bottom: 37), child: PinMarker(tone: tone))),
      );
}

LatLng latLngOf(double lat, double lng) => LatLng(lat, lng);
LatLng placeLatLng(TripPlace p) => LatLng(p.lat, p.lng);
