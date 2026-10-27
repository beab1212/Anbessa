// The search stage in the map shell (workflow 05 A1–2): the sheet rises nearly to the top with the
// map still behind it. Pickup (dot) and destination (square) fields with a swap; as you type,
// mapping-service search (debounced 300 ms, biased to the city the rider is in) with the saved,
// recent and common places, each row led by an icon for its kind (airport, church, hotel, bus
// stop, hospital, school, shop, food…) and the distance from the pickup on the right. "Use my
// location", or "Choose on the map": the sheet becomes a small card and the place is whatever is
// under the centre pin (pin_picker.dart). With both places set, the choose-ride stage replaces it.

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
import '../places/saved_places_controller.dart';
import '../shell/map_intent.dart';
import 'booking_actions.dart';
import 'booking_controller.dart';
import 'pin_picker.dart';

enum RouteField { pickup, dropoff }

@immutable
class RouteSearchState {
  const RouteSearchState({this.open = false, this.active = RouteField.dropoff, this.query = '', this.remote = const [], this.remoteFor = '', this.searching = false, this.searchDown = false, this.locating = false, this.error, this.focusTick = 0});
  /// a search is in progress (the stage is on screen, pin mode included)
  final bool open;
  /// the field being filled
  final RouteField active;
  /// what was typed in it since it got the focus
  final String query;
  final List<Place> remote;
  /// the query [remote] answers
  final String remoteFor;
  final bool searching;
  final bool searchDown;
  final bool locating;
  final Object? error;
  /// bumps when the app (not the person) moves the focus to [active]
  final int focusTick;

  RouteSearchState copyWith({RouteField? active, String? query, List<Place>? remote, String? remoteFor, bool? searching, bool? searchDown, bool? locating, Object? error, bool clearError = false, int? focusTick}) => RouteSearchState(
        open: open, active: active ?? this.active, query: query ?? this.query, remote: remote ?? this.remote, remoteFor: remoteFor ?? this.remoteFor, searching: searching ?? this.searching,
        searchDown: searchDown ?? this.searchDown, locating: locating ?? this.locating, error: clearError ? null : (error ?? this.error), focusTick: focusTick ?? this.focusTick,
      );
}

class RouteSearch extends Notifier<RouteSearchState> {
  static const debounce = Duration(milliseconds: 300);
  Timer? _timer;
  int _gen = 0;

  @override
  RouteSearchState build() {
    ref.onDispose(() => _timer?.cancel());
    return const RouteSearchState();
  }

  /// A field got the focus (from the person, or [byApp] when a pick moves on to the other one).
  void focus(RouteField f, {bool byApp = false}) {
    if (f == state.active && !byApp) return;
    _timer?.cancel();
    _gen++;
    state = state.copyWith(active: f, query: '', remote: const [], remoteFor: '', searching: false, clearError: true, focusTick: byApp ? state.focusTick + 1 : null);
  }

  /// The search stage opened with [f] focused; when it is already open (back from pin mode) the
  /// field being filled gets the focus again.
  void begin(RouteField f) {
    if (state.open) {
      state = state.copyWith(focusTick: state.focusTick + 1);
      return;
    }
    _timer?.cancel();
    _gen++;
    state = RouteSearchState(open: true, active: f, focusTick: state.focusTick + 1);
  }

  /// The search stage was left.
  void end() {
    _timer?.cancel();
    _gen++;
    if (state.open) state = RouteSearchState(focusTick: state.focusTick);
  }

  void setQuery(String text, {required String language}) {
    _timer?.cancel();
    final q = text.trim();
    final gen = ++_gen;
    state = state.copyWith(query: q, searching: false);
    if (q.length < 2) {
      state = state.copyWith(remote: const [], remoteFor: '');
      return;
    }
    _timer = Timer(debounce, () async {
      state = state.copyWith(searching: true);
      try {
        final city = ref.read(riderCityProvider);
        final results = await ref.read(apisProvider).maps.search(q, cityId: city.id, language: language);
        if (gen != _gen) return;
        state = state.copyWith(remote: results, remoteFor: q, searching: false, searchDown: false);
      } catch (_) {
        if (gen != _gen) return;
        state = state.copyWith(searching: false, searchDown: true);
      }
    });
  }

  void locating(bool v) => state = state.copyWith(locating: v);
  void fail(Object? e) => state = state.copyWith(error: e, clearError: e == null);
}

final routeSearchProvider = NotifierProvider<RouteSearch, RouteSearchState>(RouteSearch.new);

/// A place was chosen for the field being filled: with both places set, on to choosing the ride
/// (in place of the search); otherwise the other field.
void pickRoutePlace(BuildContext context, WidgetRef ref, Place p) {
  Haptics.light();
  final s = ref.read(routeSearchProvider);
  final booking = ref.read(bookingProvider.notifier);
  if (s.active == RouteField.pickup) {
    booking.setPickup(p, quote: false);
  } else {
    booking.setDropoff(p, quote: false);
  }
  ref.read(pinPickerProvider.notifier).close();
  final b = ref.read(bookingProvider);
  if (b.ready) {
    booking.quote();
    context.pushReplacement(Routes.riderQuote);
  } else {
    ref.read(routeSearchProvider.notifier).focus(b.pickup == null ? RouteField.pickup : RouteField.dropoff, byApp: true);
  }
}

/// "Use my location" for the field being filled.
Future<void> useMyLocation(BuildContext context, WidgetRef ref) async {
  final l = context.l10n;
  final search = ref.read(routeSearchProvider.notifier);
  final src = ref.read(locationSourceProvider);
  final language = context.localeTag;
  search.locating(true);
  search.fail(null);
  try {
    final perm = await src.ensurePermission(LocationProfile.once);
    if (perm != LocationPermissionState.granted) {
      search.fail(AppError(status: 0, code: 'permission', message: perm == LocationPermissionState.serviceOff ? l.locationServiceOff : l.locationPermissionNeeded));
      return;
    }
    final pos = await src.current();
    if (pos == null) return search.fail(AppError(status: 0, code: 'position', message: l.positionUnknown));
    ref.read(lastPositionProvider.notifier).set(pos);
    final pickup = ref.read(routeSearchProvider).active == RouteField.pickup;
    final p = await resolvePlace(ref.read(apisProvider).maps, pos.lat, pos.lng, snapToRoad: pickup, language: language);
    if (context.mounted) pickRoutePlace(context, ref, p);
  } catch (e) {
    search.fail(e);
  } finally {
    search.locating(false);
  }
}

/// "Choose on the map", starting at the field's place, else the rider, else the city.
void openPinPicker(BuildContext context, WidgetRef ref) {
  final s = ref.read(routeSearchProvider);
  final b = ref.read(bookingProvider);
  final current = s.active == RouteField.pickup ? b.pickup : b.dropoff;
  final me = ref.read(lastPositionProvider);
  final city = ref.read(riderCityProvider);
  final start = current != null
      ? LatLng(current.lat, current.lng)
      : me != null
          ? LatLng(me.lat, me.lng)
          : LatLng(city.bbox.centerLat, city.bbox.centerLng);
  FocusScope.of(context).unfocus();
  Haptics.selection();
  ref.read(pinPickerProvider.notifier).open(start, pickup: s.active == RouteField.pickup, language: context.localeTag);
}

/// The two fields at the top of the search sheet.
class SearchHeader extends ConsumerStatefulWidget {
  const SearchHeader({super.key, this.focusPickup = false});
  final bool focusPickup;
  @override
  ConsumerState<SearchHeader> createState() => _SearchHeaderState();
}

class _SearchHeaderState extends ConsumerState<SearchHeader> {
  final _pickup = TextEditingController();
  final _dropoff = TextEditingController();
  final _pickupFocus = FocusNode();
  final _dropoffFocus = FocusNode();
  double _swapTurns = 0;

  @override
  void initState() {
    super.initState();
    final b = ref.read(bookingProvider);
    _pickup.text = b.pickup?.name ?? '';
    _dropoff.text = b.dropoff?.name ?? '';
    _pickupFocus.addListener(() {
      if (_pickupFocus.hasFocus) ref.read(routeSearchProvider.notifier).focus(RouteField.pickup);
    });
    _dropoffFocus.addListener(() {
      if (_dropoffFocus.hasFocus) ref.read(routeSearchProvider.notifier).focus(RouteField.dropoff);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final field = widget.focusPickup ? RouteField.pickup : RouteField.dropoff;
      ref.read(routeSearchProvider.notifier).begin(field);
      // the pickup defaults to where the rider is, when that's in a served city
      if (ref.read(bookingProvider).pickup == null) {
        final here = currentLocationPlace(context, ref);
        if (here != null) ref.read(bookingProvider.notifier).setPickup(here, quote: false);
      }
    });
  }

  @override
  void dispose() {
    _pickup.dispose();
    _dropoff.dispose();
    _pickupFocus.dispose();
    _dropoffFocus.dispose();
    super.dispose();
  }

  void _swap() {
    Haptics.selection();
    setState(() => _swapTurns += 0.5);
    ref.read(bookingProvider.notifier).swap();
  }

  Widget _field(TextEditingController ctrl, FocusNode focus, {required bool pickup}) {
    final l = context.l10n;
    final c = context.colors;
    final mark = Container(width: 10, height: 10, decoration: BoxDecoration(color: pickup ? c.accent : c.text, shape: pickup ? BoxShape.circle : BoxShape.rectangle, borderRadius: pickup ? null : BorderRadius.circular(2)));
    return TextField(
      key: ValueKey(pickup ? 'search-pickup' : 'search-dropoff'),
      controller: ctrl,
      focusNode: focus,
      textInputAction: TextInputAction.search,
      onChanged: (v) {
        setState(() {});
        ref.read(routeSearchProvider.notifier).setQuery(v, language: context.localeTag);
      },
      onTap: () => ctrl.selection = TextSelection(baseOffset: 0, extentOffset: ctrl.text.length),
      decoration: InputDecoration(
        hintText: pickup ? l.pickupHint : l.dropoffHint,
        prefixIcon: Center(widthFactor: 1, child: Padding(padding: const EdgeInsets.symmetric(horizontal: 14), child: mark)),
        suffixIcon: ctrl.text.isNotEmpty && focus.hasFocus
            ? IconButton(
                tooltip: l.close,
                icon: const Icon(Icons.close_rounded, size: 18),
                onPressed: () {
                  ctrl.clear();
                  setState(() {});
                  ref.read(routeSearchProvider.notifier).setQuery('', language: context.localeTag);
                },
              )
            : null,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    // a pick (or a swap) shows in the fields; the focus follows the app's moves
    ref.listen(bookingProvider.select((b) => b.pickup), (_, p) => _pickup.text = p?.name ?? '');
    ref.listen(bookingProvider.select((b) => b.dropoff), (_, p) => _dropoff.text = p?.name ?? '');
    ref.listen(routeSearchProvider.select((s) => s.focusTick), (_, _) {
      final f = ref.read(routeSearchProvider).active;
      (f == RouteField.pickup ? _pickupFocus : _dropoffFocus).requestFocus();
      final ctrl = f == RouteField.pickup ? _pickup : _dropoff;
      ctrl.selection = TextSelection(baseOffset: 0, extentOffset: ctrl.text.length);
    });
    final ready = ref.watch(bookingProvider.select((b) => b.ready));
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          IconButton(tooltip: l.back, icon: const Icon(Icons.arrow_back_rounded), onPressed: () => context.canPop() ? context.pop() : context.go(Routes.riderHome)),
          Expanded(
            child: Column(
              children: [
                _field(_pickup, _pickupFocus, pickup: true),
                // the line between the dot and the square
                Align(alignment: AlignmentDirectional.centerStart, child: Container(margin: const EdgeInsetsDirectional.only(start: 18), width: 2, height: 6, color: c.border)),
                _field(_dropoff, _dropoffFocus, pickup: false),
              ],
            ),
          ),
          IconButton(
            tooltip: l.swapPlaces,
            onPressed: ready ? _swap : null,
            icon: AnimatedRotation(turns: _swapTurns, duration: AnbessaMotion.of(context, AnbessaMotion.medium), curve: AnbessaMotion.springSoft, child: const Icon(Icons.swap_vert_rounded)),
          ),
        ],
      ),
    );
  }
}

sealed class _Item {
  const _Item();
}

class _HeaderItem extends _Item {
  const _HeaderItem(this.text);
  final String text;
}

class _PlaceItem extends _Item {
  const _PlaceItem(this.key, this.place, this.icon, {this.subtitle});
  final String key;
  final Place place;
  final IconData icon;
  final String? subtitle;
}

/// Saved, recent and found places for the field being filled, built lazily.
class SearchSuggestions extends ConsumerWidget {
  const SearchSuggestions({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final s = ref.watch(routeSearchProvider);
    final b = ref.watch(bookingProvider);
    final city = ref.watch(riderCityProvider);
    final saved = ref.watch(savedPlacesProvider).value ?? const <SavedPlace>[];
    final recent = ref.watch(recentPlacesProvider);
    final me = ref.watch(lastPositionProvider);
    final q = s.query.toLowerCase();
    bool match(Place p) => q.isEmpty || '${p.name} ${p.label ?? ''}'.toLowerCase().contains(q);
    final common = (commonPlaces[city.id] ?? const <Place>[]).where(match).take(q.isEmpty ? 6 : 8).toList();
    final remote = q.length >= 2 && s.remoteFor.toLowerCase() == q ? s.remote.where((r) => !common.any((x) => x.name == r.name)).toList() : const <Place>[];
    final savedHits = saved.where((p) => match(p.place)).toList();
    final recentHits = recent.where(match).take(q.isEmpty ? 4 : 8).toList();

    // distances from the pickup (from the rider while the pickup itself is being chosen)
    final origin = s.active == RouteField.dropoff && b.pickup != null ? (lat: b.pickup!.lat, lng: b.pickup!.lng) : (me == null ? null : (lat: me.lat, lng: me.lng));
    String? distance(Place p) => origin == null ? null : formatDistance(haversineMeters(origin.lat, origin.lng, p.lat, p.lng));

    final items = <_Item>[
      if (savedHits.isNotEmpty) ...[
        _HeaderItem(l.savedPlacesHeader),
        for (final p in savedHits)
          _PlaceItem('saved:${p.id}', p.place, switch (p.label) { PlaceLabel.home => Icons.home_rounded, PlaceLabel.work => Icons.work_rounded, _ => Icons.star_rounded }, subtitle: p.address),
      ],
      if (recentHits.isNotEmpty) ...[
        _HeaderItem(l.recentPlaces),
        for (final p in recentHits) _PlaceItem('recent:${p.lat},${p.lng},${p.name}', p, p.category == null ? Icons.history_rounded : placeIcon(p.category, p.type)),
      ],
      if (common.isNotEmpty || remote.isNotEmpty) _HeaderItem(q.length >= 2 ? l.searchResults : l.commonPlaces),
      for (final p in common) _PlaceItem('common:${p.name}', p, placeIcon(p.category, p.type)),
      for (final p in remote) _PlaceItem('found:${p.lat},${p.lng},${p.name}', p, placeIcon(p.category, p.type)),
    ];
    final nothing = q.length >= 2 && items.isEmpty && !s.searching && !s.searchDown;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Problem(s.error, describe: (e) => describeError(l, e)),
        SuggestionRow(key: const ValueKey('use-location'), icon: Icons.my_location_rounded, title: l.useCurrentLocation, highlight: true, trailing: s.locating ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : null, onTap: s.locating ? null : () => useMyLocation(context, ref)),
        SuggestionRow(key: const ValueKey('choose-on-map'), icon: Icons.map_rounded, title: l.chooseOnMap, highlight: true, onTap: () => openPinPicker(context, ref)),
        const Divider(height: 12),
        if (s.searchDown && q.length >= 2) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Notice(l.searchDown, tone: NoticeTone.warning)),
        if (s.searching) const SkeletonList(rows: 3),
        ListView.builder(
          // the sheet scrolls; the list sizes to its rows
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: EdgeInsets.zero,
          itemCount: items.length,
          itemBuilder: (context, i) => switch (items[i]) {
            _HeaderItem(:final text) => _Header(key: ValueKey('h:$text'), text: text),
            final _PlaceItem it => SuggestionRow(
                key: ValueKey(it.key),
                icon: it.icon,
                title: it.place.name,
                subtitle: it.subtitle ?? it.place.label,
                distance: distance(it.place),
                onTap: () => pickRoutePlace(context, ref, it.place),
              ),
          },
        ),
        if (nothing) IllustratedEmpty(illustration: AnbessaIllustration.searchEmpty, title: l.noResults, compact: true),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({super.key, required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 4),
        child: Text(text, style: AnbessaType.label.copyWith(color: context.colors.muted, letterSpacing: 0.4)),
      );
}

/// The sheet in pin mode: the address under the pin (looked up as the map settles) and Confirm.
class PinCard extends ConsumerWidget {
  const PinCard({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final p = ref.watch(pinPickerProvider);
    final busy = p.resolving || p.lifted;
    // the system back closes the pin first
    return BackButtonListener(
      onBackButtonPressed: () async {
        ref.read(pinPickerProvider.notifier).close();
        return true;
      },
      child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(l.rideMovePin, style: AnbessaType.caption.copyWith(color: c.muted)),
        const SizedBox(height: 8),
        if (p.error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Problem(p.error, describe: (e) => describeError(l, e))),
        Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(color: c.accentSoft, shape: BoxShape.circle),
              child: Icon(p.place == null ? Icons.place_rounded : placeIcon(p.place!.category, p.place!.type), color: c.text, size: 20),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: AnimatedSwitcherX(
                child: busy
                    ? const Column(key: ValueKey('busy'), crossAxisAlignment: CrossAxisAlignment.start, children: [Skeleton.line(width: 180, height: 18), SizedBox(height: 6), Skeleton.line(width: 120, height: 12)])
                    : Column(
                        key: ValueKey('place:${p.place?.name}'),
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(p.place?.name ?? '—', style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                          if ((p.place?.label ?? '').isNotEmpty) Text(p.place!.label!, style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
                        ],
                      ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        PrimaryButton(
          label: p.pickup ? l.confirmPickup : l.confirmDropoff,
          icon: Icons.check_rounded,
          onPressed: busy || p.place == null ? null : () => pickRoutePlace(context, ref, p.place!),
        ),
      ],
      ),
    );
  }
}
