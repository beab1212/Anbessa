// "Choose on the map" in the search stage: the sheet becomes a small card and the place under the
// centre pin is the answer. The pin lifts while the map is dragged and drops when it stops; the
// address is looked up 350 ms after the map settles, and an answer for a centre the person has
// since moved away from is dropped (only the latest lookup counts). Pickups are snapped to the
// road first.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../config/client_config_provider.dart';

@immutable
class PinState {
  const PinState({this.active = false, this.session = 0, this.start = const LatLng(0, 0), this.pickup = false, this.lifted = false, this.place, this.resolving = false, this.error});
  final bool active;
  /// a new number each time pin mode opens (the camera centres on [start] again)
  final int session;
  final LatLng start;
  /// picking the pickup (snapped to the road) rather than the drop-off
  final bool pickup;
  /// the map is being dragged under the pin
  final bool lifted;
  /// the named place under the pin
  final Place? place;
  final bool resolving;
  final Object? error;

  PinState copyWith({bool? lifted, Place? place, bool? resolving, Object? error, bool clearPlace = false, bool clearError = false}) => PinState(
        active: active, session: session, start: start, pickup: pickup,
        lifted: lifted ?? this.lifted, place: clearPlace ? null : (place ?? this.place), resolving: resolving ?? this.resolving, error: clearError ? null : (error ?? this.error),
      );
}

class PinPicker extends Notifier<PinState> {
  static const debounce = Duration(milliseconds: 350);
  Timer? _timer;
  int _gen = 0;
  String _language = 'en';

  @override
  PinState build() {
    ref.onDispose(() => _timer?.cancel());
    return const PinState();
  }

  /// Start picking around [start]; the place there is looked up at once.
  void open(LatLng start, {required bool pickup, String language = 'en'}) {
    _language = language;
    state = PinState(active: true, session: state.session + 1, start: start, pickup: pickup);
    moved(start);
  }

  void close() {
    _timer?.cancel();
    _gen++;
    if (state.active) state = PinState(session: state.session);
  }

  /// The person started moving the map.
  void lift() {
    if (!state.active) return;
    _timer?.cancel();
    _gen++; // whatever was being looked up is no longer under the pin
    state = state.copyWith(lifted: true, resolving: true, clearError: true);
  }

  /// The map came to rest with [center] under the pin.
  void moved(LatLng center) {
    if (!state.active) return;
    _timer?.cancel();
    final gen = ++_gen;
    final cfg = ref.read(configProvider);
    if (cfg.cityAt(center.latitude, center.longitude) == null) {
      state = state.copyWith(lifted: false, resolving: false, clearPlace: true, error: const AppError(status: 400, code: ErrorCodes.outsideServiceArea, message: 'outside the service area'));
      return;
    }
    state = state.copyWith(lifted: false, resolving: true, clearError: true);
    _timer = Timer(debounce, () => _resolve(center, gen));
  }

  Future<void> _resolve(LatLng center, int gen) async {
    final place = await resolvePlace(ref.read(apisProvider).maps, center.latitude, center.longitude, snapToRoad: state.pickup, language: _language);
    if (gen != _gen || !state.active) return; // superseded by a newer centre
    state = state.copyWith(place: place, resolving: false);
  }
}

final pinPickerProvider = NotifierProvider<PinPicker, PinState>(PinPicker.new);

/// Name the point (snapped to the road first for a pickup); coordinates when nothing answers.
Future<Place> resolvePlace(MapsApi maps, double lat, double lng, {required bool snapToRoad, String language = 'en'}) async {
  var p = (lat: lat, lng: lng);
  if (snapToRoad) {
    try {
      p = await maps.snap(lat, lng);
    } catch (_) {}
  }
  try {
    final r = await maps.reverse(p.lat, p.lng, language: language);
    if (r != null && r.name.isNotEmpty) return Place(name: r.name, label: r.label, lat: p.lat, lng: p.lng, category: r.category, type: r.type);
  } catch (_) {}
  return Place(name: '${p.lat.toStringAsFixed(4)}, ${p.lng.toStringAsFixed(4)}', lat: p.lat, lng: p.lng);
}
