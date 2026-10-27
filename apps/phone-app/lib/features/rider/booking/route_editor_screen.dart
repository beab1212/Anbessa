// Where from and where to, on one screen (workflow 05 A1–2): two fields, search as you type
// (mapping-service, debounced 300 ms) grouped with saved, recent and popular places, "use my
// location", or drag the map and confirm the centre (reverse-geocoded, pickups snapped to the
// road). Also picks a place to save (`mode=savedPlace`), returning it to the caller.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/location/location_source.dart';
import '../../../core/network/providers.dart';
import '../../../core/router/routes.dart';
import '../../config/client_config_provider.dart';
import '../../maps/anbessa_map.dart';
import '../places/saved_places_controller.dart';
import 'booking_controller.dart';

enum RouteField { pickup, dropoff }

enum RouteEditorMode { book, savedPlace }

class RouteEditorScreen extends ConsumerStatefulWidget {
  const RouteEditorScreen({super.key, this.focus = RouteField.dropoff, this.mode = RouteEditorMode.book, this.savedLabel});
  final RouteField focus;
  final RouteEditorMode mode;
  /// home | work | other, in savedPlace mode
  final String? savedLabel;
  @override
  ConsumerState<RouteEditorScreen> createState() => _RouteEditorScreenState();
}

class _RouteEditorScreenState extends ConsumerState<RouteEditorScreen> {
  final _pickupCtrl = TextEditingController();
  final _dropoffCtrl = TextEditingController();
  final _pickupFocus = FocusNode();
  final _dropoffFocus = FocusNode();
  late RouteField _active = widget.focus;
  Timer? _debounce;
  List<Place> _remote = const [];
  String _remoteFor = '';
  bool _searchDown = false;
  bool _searching = false;
  bool _onMap = false;
  bool _pinLifted = false;
  Place? _mapPlace;
  bool _resolving = false;
  Object? _error;

  bool get _savedMode => widget.mode == RouteEditorMode.savedPlace;

  @override
  void initState() {
    super.initState();
    final b = ref.read(bookingProvider);
    _pickupCtrl.text = b.pickup?.name ?? '';
    _dropoffCtrl.text = b.dropoff?.name ?? '';
    _pickupFocus.addListener(() {
      if (_pickupFocus.hasFocus) setState(() => _active = RouteField.pickup);
    });
    _dropoffFocus.addListener(() {
      if (_dropoffFocus.hasFocus) setState(() => _active = RouteField.dropoff);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (_savedMode) {
        _dropoffFocus.requestFocus();
      } else {
        (widget.focus == RouteField.pickup ? _pickupFocus : _dropoffFocus).requestFocus();
      }
      // the pickup defaults to where the person is, when that's in a served city
      if (!_savedMode && b.pickup == null) {
        final me = ref.read(lastPositionProvider);
        if (me != null && ref.read(configProvider).cityAt(me.lat, me.lng) != null) {
          final p = Place(name: context.l10n.currentLocation, lat: me.lat, lng: me.lng);
          ref.read(bookingProvider.notifier).setPickup(p, quote: false);
          _pickupCtrl.text = p.name;
          if (widget.focus == RouteField.pickup && b.dropoff != null) _pickupCtrl.selection = TextSelection(baseOffset: 0, extentOffset: p.name.length);
        }
      }
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _pickupCtrl.dispose();
    _dropoffCtrl.dispose();
    _pickupFocus.dispose();
    _dropoffFocus.dispose();
    super.dispose();
  }

  TextEditingController get _activeCtrl => _active == RouteField.pickup ? _pickupCtrl : _dropoffCtrl;

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

  /// A place was chosen for the active field.
  void _picked(Place p) {
    Haptics.light();
    if (_savedMode) {
      context.pop(p);
      return;
    }
    final ctrl = ref.read(bookingProvider.notifier);
    if (_active == RouteField.pickup) {
      ctrl.setPickup(p, quote: false);
      _pickupCtrl.text = p.name;
    } else {
      ctrl.setDropoff(p, quote: false);
      _dropoffCtrl.text = p.name;
    }
    final b = ref.read(bookingProvider);
    if (b.ready) {
      ctrl.quote();
      context.pushReplacement(Routes.riderQuote);
    } else {
      setState(() {
        _onMap = false;
        _remote = const [];
      });
      (b.pickup == null ? _pickupFocus : _dropoffFocus).requestFocus();
      _activeCtrl.clear();
    }
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
      _picked(await _resolve(pos.lat, pos.lng));
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
    if (_active == RouteField.pickup && !_savedMode) {
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
    setState(() => _pinLifted = false);
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
    final b = ref.watch(bookingProvider);
    final text = _activeCtrl.text.trim();
    final saved = ref.watch(savedPlacesProvider).value ?? const <SavedPlace>[];
    final recent = ref.watch(recentPlacesProvider);
    final common = commonPlaces[city.id] ?? const <Place>[];
    final q = text.toLowerCase();
    bool match(Place p) => q.isEmpty || '${p.name} ${p.label ?? ''}'.toLowerCase().contains(q);
    final savedHits = _savedMode ? const <SavedPlace>[] : saved.where((p) => match(p.place)).toList();
    final recentHits = _savedMode ? const <Place>[] : recent.where(match).take(q.isEmpty ? 4 : 8).toList();
    final local = common.where(match).take(q.isEmpty ? 6 : 8).toList();
    final remote = text.length >= 2 && _remoteFor == text ? _remote.where((r) => !local.any((x) => x.name == r.name)).toList() : const <Place>[];
    final activePickup = _active == RouteField.pickup && !_savedMode;
    final tone = activePickup ? PinTone.pickup : PinTone.dropoff;

    if (_onMap) {
      final start = ref.read(lastPositionProvider)?.let((p) => LatLng(p.lat, p.lng)) ?? LatLng(city.bbox.centerLat, city.bbox.centerLng);
      return Scaffold(
        body: Stack(
          children: [
            AnbessaMap(
              center: start,
              zoom: 16,
              onMove: _onMapMoved,
              onUserGesture: () => setState(() => _pinLifted = true),
              showControls: false,
              bottomInset: 180,
            ),
            CenterPin(tone: tone, lifted: _pinLifted),
            Positioned(
              top: MediaQuery.paddingOf(context).top + 8,
              left: 12,
              child: MapControlButton(icon: Icons.arrow_back, tooltip: l.back, onTap: () => setState(() => _onMap = false)),
            ),
            Positioned(
              left: 16,
              right: 16,
              bottom: 16 + MediaQuery.paddingOf(context).bottom,
              child: FloatingCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Problem(_error, describe: (e) => describeError(l, e))),
                    if (_resolving) const Skeleton.line(width: 180, height: 18) else Text(_mapPlace?.name ?? '—', style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 2),
                    if (_resolving) const Skeleton.line(width: 120, height: 12) else Text(_mapPlace?.label ?? ' ', style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
                    const SizedBox(height: 12),
                    PrimaryButton(
                      label: _savedMode ? l.savePlace : (activePickup ? l.confirmPickup : l.confirmDropoff),
                      icon: Icons.check_rounded,
                      onPressed: _mapPlace == null || _resolving ? null : () => _picked(_mapPlace!),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
    }

    Widget field(RouteField f, TextEditingController ctrl, FocusNode focus, Color? dot, String hint, {bool square = false}) => TextField(
          controller: ctrl,
          focusNode: focus,
          textInputAction: TextInputAction.search,
          onChanged: (v) {
            setState(() {});
            _onQuery(v);
          },
          onTap: () => ctrl.selection = TextSelection(baseOffset: 0, extentOffset: ctrl.text.length),
          decoration: InputDecoration(
            hintText: hint,
            // pickup / drop-off keep the map's plain dot and square; the search field has none
            prefixIcon: dot == null ? null : Center(widthFactor: 1, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 14), child: Container(width: 10, height: 10, decoration: BoxDecoration(color: dot, shape: square ? BoxShape.rectangle : BoxShape.circle)))),
            suffixIcon: ctrl.text.isNotEmpty
                ? IconButton(
                    tooltip: l.close,
                    icon: const Icon(Icons.close, size: 18),
                    onPressed: () {
                      ctrl.clear();
                      setState(() => _remote = const []);
                    },
                  )
                : null,
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          ),
        );

    return Scaffold(
      appBar: AppBar(title: Text(_savedMode ? l.savePlaceTitle : l.routeTitle)),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: _savedMode
                ? field(RouteField.dropoff, _dropoffCtrl, _dropoffFocus, null, l.searchPlaces)
                : Row(
                    children: [
                      Expanded(
                        child: Column(
                          children: [
                            field(RouteField.pickup, _pickupCtrl, _pickupFocus, c.accent, l.pickupHint),
                            const SizedBox(height: 8),
                            field(RouteField.dropoff, _dropoffCtrl, _dropoffFocus, c.text, l.dropoffHint, square: true),
                          ],
                        ),
                      ),
                      const SizedBox(width: 6),
                      IconButton(
                        tooltip: l.swapPlaces,
                        onPressed: !b.ready
                            ? null
                            : () {
                                Haptics.selection();
                                ref.read(bookingProvider.notifier).swap();
                                final t = _pickupCtrl.text;
                                _pickupCtrl.text = _dropoffCtrl.text;
                                _dropoffCtrl.text = t;
                              },
                        icon: const Icon(Icons.swap_vert_rounded),
                      ),
                    ],
                  ),
          ),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Problem(_error, describe: (e) => describeError(l, e))),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: [
                _Row(title: l.useCurrentLocation, busy: _resolving, onTap: _resolving ? null : _useMyLocation),
                _Row(title: l.chooseOnMap, onTap: () => setState(() => _onMap = true)),
                const Divider(height: 8),
                if (_searchDown && text.length >= 2) Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 8), child: Notice(l.searchDown, tone: NoticeTone.warning)),
                if (_searching) const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: SkeletonList(rows: 3)),
                if (savedHits.isNotEmpty) ...[
                  _Header(l.savedPlacesHeader),
                  for (final p in savedHits) _Row(title: p.name, subtitle: p.address, onTap: () => _picked(p.place)),
                ],
                if (recentHits.isNotEmpty) ...[
                  _Header(l.recentPlaces),
                  for (final p in recentHits) _Row(title: p.name, subtitle: p.label, onTap: () => _picked(p)),
                ],
                if (local.isNotEmpty || remote.isNotEmpty) _Header(text.length >= 2 ? l.searchResults : l.commonPlaces),
                for (final p in local) _Row(title: p.name, subtitle: p.label, onTap: () => _picked(p)),
                for (final p in remote) _Row(title: p.name, subtitle: p.label, onTap: () => _picked(p)),
                if (text.length >= 2 && savedHits.isEmpty && recentHits.isEmpty && local.isEmpty && remote.isEmpty && !_searching && !_searchDown)
                  IllustratedEmpty(illustration: AnbessaIllustration.searchEmpty, title: l.noResults, compact: true),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 14, 16, 4),
        child: Text(text, style: AnbessaType.label.copyWith(color: context.colors.muted, letterSpacing: 0.4)),
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.title, this.subtitle, this.onTap, this.busy = false});
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool busy;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListTile(
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w500)),
      subtitle: subtitle == null || subtitle!.isEmpty ? null : Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.caption.copyWith(color: c.muted)),
      trailing: busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : null,
      onTap: onTap,
    );
  }
}
