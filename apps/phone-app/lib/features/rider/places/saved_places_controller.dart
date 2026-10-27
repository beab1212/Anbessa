// Home, Work and the other saved places (trip-service /api/trips/places).

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../../core/network/providers.dart';
import '../../../core/session/session_controller.dart';

class SavedPlacesController extends AsyncNotifier<List<SavedPlace>> {
  @override
  Future<List<SavedPlace>> build() async {
    if (ref.watch(currentSessionProvider) == null) return const [];
    return ref.read(apisProvider).trips.places();
  }

  Future<void> refresh() async {
    state = AsyncData(await ref.read(apisProvider).trips.places());
  }

  Future<void> setFixed(PlaceLabel label, Place p) async {
    await ref.read(apisProvider).trips.setFixedPlace(label, p);
    await refresh();
  }

  Future<void> add(Place p) async {
    await ref.read(apisProvider).trips.addPlace(p);
    await refresh();
  }

  Future<void> remove(String id) async {
    await ref.read(apisProvider).trips.removePlace(id);
    state = AsyncData((state.value ?? const []).where((p) => p.id != id).toList());
  }
}

final savedPlacesProvider = AsyncNotifierProvider<SavedPlacesController, List<SavedPlace>>(SavedPlacesController.new);

final homePlaceProvider = Provider<SavedPlace?>((ref) => ref.watch(savedPlacesProvider).value?.where((p) => p.label == PlaceLabel.home).firstOrNull);
final workPlaceProvider = Provider<SavedPlace?>((ref) => ref.watch(savedPlacesProvider).value?.where((p) => p.label == PlaceLabel.work).firstOrNull);
