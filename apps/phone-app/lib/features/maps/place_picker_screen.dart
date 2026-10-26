// Picking a place (workflow 05 A1–2): search as you type (mapping-service, debounced 300 ms),
// the popular places first and as the fallback when search is down, "use my location", or drag
// the map and confirm the centre (reverse-geocoded, pickups snapped to the road).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/location/location_source.dart';
import '../../core/network/providers.dart';
import '../config/client_config_provider.dart';
import 'anbessa_map.dart';

enum PickWhat { pickup, dropoff }

class PlacePickerScreen extends ConsumerStatefulWidget {
  const PlacePickerScreen({super.key, required this.what, this.initial, required this.onPicked});
  final PickWhat what;
  final Place? initial;
  final void Function(Place place) onPicked;
  @override
  ConsumerState<PlacePickerScreen> createState() => _PlacePickerScreenState();
}

class _PlacePickerScreenState extends ConsumerState<PlacePickerScreen> {
  final _q = TextEditingController();
  Timer? _debounce;
  List<Place> _remote = const [];
  String _remoteFor = '';
  bool _searchDown = false;
  bool _searching = false;
  bool _onMap = false;
  Place? _mapPlace;
  bool _resolving = false;
  Object? _error;
  final _mapCtrl = MapController();

  @override
  void dispose() {
    _debounce?.cancel();
    _q.dispose();
    _mapCtrl.dispose();
    super.dispose();
  }

  void _onQuery(String v) {
    _debounce?.cancel();
    final text = v.trim();
    if (text.length < 2) return setState(() => _remote = const []);
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      setState(() => _searching = true);
      try {
        final city = ref.read(currentCityProvider);
        final results = await ref.read(apisProvider).maps.search(text, cityId: city.id, language: context.localeTag);
        if (!mounted) return;
        setState(() {
          _remote = results;
          _remoteFor = text;
          _searchDown = false;
        });
      } catch (_) {
        if (mounted) setState(() => _searchDown = true);
      } finally {
        if (mounted) setState(() => _searching = false);
      }
    });
  }

  Future<void> _useMyLocation() async {
    final l = context.l10n;
    final src = ref.read(locationSourceProvider);
    setState(() {
      _resolving = true;
      _error = null;
    });
    try {
      final perm = await src.ensurePermission(LocationProfile.once);
      if (perm != LocationPermissionState.granted) {
        setState(() => _error = AppError(status: 0, code: 'permission', message: perm == LocationPermissionState.serviceOff ? l.locationServiceOff : l.locationPermissionNeeded));
        return;
      }
      final pos = await src.current();
      if (pos == null) return setState(() => _error = AppError(status: 0, code: 'position', message: l.positionUnknown));
      ref.read(lastPositionProvider.notifier).set(pos);
      final place = await _resolve(pos.lat, pos.lng);
      widget.onPicked(place);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _resolving = false);
    }
  }

  /// Snap pickups to the road, then name the point.
  Future<Place> _resolve(double lat, double lng) async {
    final maps = ref.read(apisProvider).maps;
    final language = context.localeTag;
    var p = (lat: lat, lng: lng);
    if (widget.what == PickWhat.pickup) {
      try {
        p = await maps.snap(lat, lng);
      } catch (_) {}
    }
    try {
      final r = await maps.reverse(p.lat, p.lng, language: language);
      if (r != null && r.name.isNotEmpty) return Place(name: r.name, label: r.label, lat: p.lat, lng: p.lng);
    } catch (_) {}
    return Place(name: '${p.lat.toStringAsFixed(4)}, ${p.lng.toStringAsFixed(4)}', lat: p.lat, lng: p.lng);
  }

  Future<void> _onMapMoved(LatLng center) async {
    final cfg = ref.read(configProvider);
    if (cfg.cityAt(center.latitude, center.longitude) == null) {
      return setState(() {
        _mapPlace = null;
        _error = AppError(status: 400, code: ErrorCodes.outsideServiceArea, message: context.l10n.outsideServiceArea);
      });
    }
    setState(() {
      _resolving = true;
      _error = null;
    });
    final place = await _resolve(center.latitude, center.longitude);
    if (mounted) {
      setState(() {
        _mapPlace = place;
        _resolving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final city = ref.watch(currentCityProvider);
    final text = _q.text.trim();
    final common = commonPlaces[city.id] ?? const <Place>[];
    final local = common.where((p) => '${p.name} ${p.label ?? ''}'.toLowerCase().contains(text.toLowerCase())).toList();
    final results = text.length >= 2 ? [...local, ..._remoteFor == text ? _remote.where((r) => !local.any((x) => x.name == r.name)) : const <Place>[]].take(8).toList() : common.take(6).toList();
    final title = widget.what == PickWhat.pickup ? l.pickupLabel : l.dropoffLabel;

    if (_onMap) {
      final start = widget.initial != null ? LatLng(widget.initial!.lat, widget.initial!.lng) : (ref.read(lastPositionProvider)?.let((p) => LatLng(p.lat, p.lng)) ?? LatLng(city.bbox.centerLat, city.bbox.centerLng));
      return Scaffold(
        appBar: AppBar(title: Text(title), leading: IconButton(icon: const Icon(Icons.arrow_back), onPressed: () => setState(() => _onMap = false))),
        body: Stack(
          children: [
            AnbessaMap(controller: _mapCtrl, center: start, zoom: 15, onMove: _onMapMoved),
            CenterPin(tone: widget.what == PickWhat.pickup ? PinTone.amber : PinTone.ink),
            Positioned(
              left: 16,
              right: 16,
              bottom: 16,
              child: Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Problem(_error, describe: (e) => describeError(l, e))),
                      Text(_resolving ? l.loading : (_mapPlace?.name ?? '—'), style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                      if (_mapPlace?.label != null) Text(_mapPlace!.label!, style: TextStyle(color: c.muted, fontSize: 13)),
                      const SizedBox(height: 10),
                      PrimaryButton(label: widget.what == PickWhat.pickup ? l.confirmPickup : l.confirmDropoff, onPressed: _mapPlace == null || _resolving ? null : () => widget.onPicked(_mapPlace!)),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: TextField(
              controller: _q,
              autofocus: true,
              onChanged: (v) {
                setState(() {});
                _onQuery(v);
              },
              decoration: InputDecoration(hintText: l.searchPlaces, prefixIcon: const Icon(Icons.search), suffixIcon: _searching ? const Padding(padding: EdgeInsets.all(12), child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))) : null),
            ),
          ),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Problem(_error, describe: (e) => describeError(l, e))),
          Expanded(
            child: ListView(
              children: [
                ListTile(leading: Icon(Icons.my_location, color: c.accentStrong), title: Text(l.useCurrentLocation), trailing: _resolving ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : null, onTap: _resolving ? null : _useMyLocation),
                ListTile(leading: Icon(Icons.map_outlined, color: c.accentStrong), title: Text(l.chooseOnMap), onTap: () => setState(() => _onMap = true)),
                const Divider(),
                if (_searchDown && text.length >= 2) Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 8), child: Notice(l.searchDown, tone: NoticeTone.warning)),
                if (text.length < 2) Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 4), child: Text(l.commonPlaces, style: TextStyle(color: c.muted, fontWeight: FontWeight.w600, fontSize: 12))),
                if (text.length >= 2 && results.isEmpty && !_searching && !_searchDown) Padding(padding: const EdgeInsets.all(16), child: Text(l.noResults, style: TextStyle(color: c.muted))),
                for (final p in results)
                  ListTile(
                    leading: Icon(Icons.place_outlined, color: c.muted),
                    title: Text(p.name),
                    subtitle: p.label == null ? null : Text(p.label!, maxLines: 1, overflow: TextOverflow.ellipsis),
                    onTap: () => widget.onPicked(p),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
