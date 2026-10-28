// The search stage in the map shell (workflow 05 A1–2), drawn as the GoRide kit's "Where do you
// want to go?" page over the shell (the map stays alive under it): ✕ and the title; a card with
// the pickup (amber dot, "Current location" by default) and destination (red pin) fields and the
// chips "Select from map", "Use my location" (while the pickup is being filled), Home, Work and
// the other saved places; Recent | Suggested tabs while nothing is typed; as you type,
// mapping-service search (debounced 300 ms, biased to the city the rider is in) with the saved,
// recent and popular places. Each row: the place's kind in a hairline circle (airport, church,
// hotel, hospital…, a pin otherwise), the name, the address, the distance from the pickup, and a
// bookmark that saves or forgets it. "Select from map": the page gives way to the map and the
// sheet becomes "Set pickup location" / "Set destination" with the place under the centre pin
// (pin_picker.dart). With both places set, the choose-ride stage replaces it.

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
import '../../shell/shells.dart' show bannerHeightProvider;
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

bool _samePlace(double aLat, double aLng, double bLat, double bLng) => (aLat - bLat).abs() < 1e-5 && (aLng - bLng).abs() < 1e-5;

/// The saved place at [p], if the rider saved it.
SavedPlace? savedAt(List<SavedPlace> saved, Place p) => saved.where((s) => _samePlace(s.lat, s.lng, p.lat, p.lng)).firstOrNull;

/// The bookmark of a row: save the place, or forget it.
Future<void> toggleSaved(BuildContext context, WidgetRef ref, Place p) async {
  final l = context.l10n;
  final ctrl = ref.read(savedPlacesProvider.notifier);
  final existing = savedAt(ref.read(savedPlacesProvider).value ?? const [], p);
  Haptics.selection();
  try {
    if (existing != null) {
      await ctrl.remove(existing.id);
      if (context.mounted) showToast(context, l.grPlaceRemoved);
    } else {
      await ctrl.add(p);
      if (context.mounted) showToast(context, l.placeSaved, tone: NoticeTone.ok);
    }
  } catch (e) {
    if (context.mounted) showToast(context, describeError(l, e), tone: NoticeTone.error);
  }
}

enum _SearchTab { recent, suggested }

/// "Where do you want to go?": the full page of the search stage.
class SearchPage extends ConsumerStatefulWidget {
  const SearchPage({super.key, this.focusPickup = false});
  final bool focusPickup;
  @override
  ConsumerState<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends ConsumerState<SearchPage> {
  final _pickup = TextEditingController();
  final _dropoff = TextEditingController();
  final _pickupFocus = FocusNode();
  final _dropoffFocus = FocusNode();
  _SearchTab? _tab;

  @override
  void initState() {
    super.initState();
    final b = ref.read(bookingProvider);
    _pickup.text = b.pickup?.name ?? '';
    _dropoff.text = b.dropoff?.name ?? '';
    _pickupFocus.addListener(() {
      if (_pickupFocus.hasFocus) ref.read(routeSearchProvider.notifier).focus(RouteField.pickup);
      if (mounted) setState(() {});
    });
    _dropoffFocus.addListener(() {
      if (_dropoffFocus.hasFocus) ref.read(routeSearchProvider.notifier).focus(RouteField.dropoff);
      if (mounted) setState(() {});
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

  void _close() {
    FocusScope.of(context).unfocus();
    context.canPop() ? context.pop() : context.go(Routes.riderHome);
  }

  Widget _field(TextEditingController ctrl, FocusNode focus, {required bool pickup}) {
    final l = context.l10n;
    final c = context.colors;
    final mark = pickup
        ? Container(
            width: 16,
            height: 16,
            decoration: BoxDecoration(shape: BoxShape.circle, color: c.accent.withValues(alpha: 0.25)),
            alignment: Alignment.center,
            child: Container(width: 9, height: 9, decoration: BoxDecoration(shape: BoxShape.circle, color: c.accent)),
          )
        : Icon(Icons.location_on_rounded, size: 20, color: c.danger);
    return FilledField(
      key: ValueKey(pickup ? 'search-pickup' : 'search-dropoff'),
      controller: ctrl,
      focusNode: focus,
      hint: pickup ? l.grYourCurrentLocation : l.dropoffHint,
      textInputAction: TextInputAction.search,
      prefix: Padding(padding: const EdgeInsetsDirectional.only(start: 16, end: 12), child: SizedBox(width: 20, child: Center(child: mark))),
      onChanged: (v) {
        setState(() {});
        ref.read(routeSearchProvider.notifier).setQuery(v, language: context.localeTag);
      },
      onTap: () => ctrl.selection = TextSelection(baseOffset: 0, extentOffset: ctrl.text.length),
      suffix: ctrl.text.isNotEmpty && focus.hasFocus
          ? IconButton(
              tooltip: l.close,
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.close_rounded, size: 18, color: c.muted),
              onPressed: () {
                ctrl.clear();
                setState(() {});
                ref.read(routeSearchProvider.notifier).setQuery('', language: context.localeTag);
              },
            )
          : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    // a pick shows in the fields; the focus follows the app's moves
    ref.listen(bookingProvider.select((b) => b.pickup), (_, p) => _pickup.text = p?.name ?? '');
    ref.listen(bookingProvider.select((b) => b.dropoff), (_, p) => _dropoff.text = p?.name ?? '');
    ref.listen(routeSearchProvider.select((s) => s.focusTick), (_, _) {
      final f = ref.read(routeSearchProvider).active;
      (f == RouteField.pickup ? _pickupFocus : _dropoffFocus).requestFocus();
      final ctrl = f == RouteField.pickup ? _pickup : _dropoff;
      ctrl.selection = TextSelection(baseOffset: 0, extentOffset: ctrl.text.length);
    });
    final s = ref.watch(routeSearchProvider);
    final home = ref.watch(homePlaceProvider);
    final work = ref.watch(workPlaceProvider);
    final saved = ref.watch(savedPlacesProvider).value ?? const <SavedPlace>[];
    final recent = ref.watch(recentPlacesProvider);
    final others = saved.where((p) => p.label == PlaceLabel.other).toList();
    final typing = s.query.length >= 2;
    final tab = _tab ?? (recent.isEmpty ? _SearchTab.suggested : _SearchTab.recent);

    final card = AppCard(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _field(_pickup, _pickupFocus, pickup: true),
          Divider(height: 25, color: c.border),
          _field(_dropoff, _dropoffFocus, pickup: false),
          Divider(height: 25, color: c.border),
          ChipRow(
            padding: EdgeInsets.zero,
            children: [
              OutlineChip(key: const ValueKey('choose-on-map'), label: l.grSelectFromMap, icon: Icons.map_outlined, onTap: () => openPinPicker(context, ref)),
              if (s.active == RouteField.pickup)
                OutlineChip(key: const ValueKey('use-location'), label: s.locating ? '…' : l.useCurrentLocation, icon: Icons.my_location_rounded, onTap: s.locating ? null : () => useMyLocation(context, ref)),
              if (home != null) OutlineChip(key: const ValueKey('chip-home'), label: l.savedHome, onTap: () => pickRoutePlace(context, ref, home.place)),
              if (work != null) OutlineChip(key: const ValueKey('chip-work'), label: l.savedWork, onTap: () => pickRoutePlace(context, ref, work.place)),
              for (final p in others) OutlineChip(key: ValueKey('chip-${p.id}'), label: p.name, onTap: () => pickRoutePlace(context, ref, p.place)),
            ],
          ),
        ],
      ),
    );

    // the banners (announcements, connection) float over the shell: the page starts under them
    final bannerH = ref.watch(bannerHeightProvider);
    final page = Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.grWhereDoYouWantToGo, leadingKind: TopBarLeading.close, centerTitle: false, onLeading: _close, leadingTooltip: l.close),
      body: BackButtonListener(
        onBackButtonPressed: () async {
          _close();
          return true;
        },
        child: ListView(
          padding: EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24 + MediaQuery.paddingOf(context).bottom),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          children: [
            card,
            const SizedBox(height: 16),
            Problem(s.error, describe: (e) => describeError(l, e)),
            if (s.searchDown && typing) Padding(padding: const EdgeInsets.only(bottom: 8), child: Notice(l.searchDown, tone: NoticeTone.warning)),
            if (!typing) ...[
              SegmentedTabs<_SearchTab>(
                items: [(_SearchTab.recent, l.recentPlaces), (_SearchTab.suggested, l.grSuggested)],
                selected: tab,
                onChanged: (t) => setState(() => _tab = t),
              ),
              const SizedBox(height: 4),
            ],
            _SearchResults(tab: typing ? null : tab),
          ],
        ),
      ),
    );
    if (bannerH <= 0) return page;
    return ColoredBox(
      color: c.page,
      child: Padding(padding: EdgeInsets.only(top: bannerH), child: MediaQuery.removePadding(context: context, removeTop: true, child: page)),
    );
  }
}

class _PlaceItem {
  const _PlaceItem(this.key, this.place, this.icon, {this.subtitle, this.recent = false});
  final String key;
  final Place place;
  final IconData icon;
  final String? subtitle;
  /// a recent place: swipe to forget it
  final bool recent;
}

/// The rows of the search page: the tab's places, or what matches what was typed.
class _SearchResults extends ConsumerWidget {
  const _SearchResults({required this.tab});
  /// null while typing (every match in one list)
  final _SearchTab? tab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final s = ref.watch(routeSearchProvider);
    final b = ref.watch(bookingProvider);
    final city = ref.watch(riderCityProvider);
    final saved = ref.watch(savedPlacesProvider).value ?? const <SavedPlace>[];
    final recent = ref.watch(recentPlacesProvider);
    final me = ref.watch(lastPositionProvider);
    final q = s.query.toLowerCase();
    bool match(Place p) => q.isEmpty || '${p.name} ${p.label ?? ''}'.toLowerCase().contains(q);
    IconData kindIcon(Place p) => p.category == null ? Icons.location_on_outlined : placeIcon(p.category, p.type);
    IconData savedIcon(SavedPlace p) => switch (p.label) { PlaceLabel.home => Icons.home_outlined, PlaceLabel.work => Icons.work_outline_rounded, _ => Icons.location_on_outlined };

    // distances from the pickup (from the rider while the pickup itself is being chosen)
    final origin = s.active == RouteField.dropoff && b.pickup != null ? (lat: b.pickup!.lat, lng: b.pickup!.lng) : (me == null ? null : (lat: me.lat, lng: me.lng));
    String? distance(Place p) => origin == null ? null : formatDistance(haversineMeters(origin.lat, origin.lng, p.lat, p.lng));

    final items = <_PlaceItem>[];
    switch (tab) {
      case _SearchTab.recent:
        items.addAll([for (final p in recent.take(8)) _PlaceItem('recent:${p.lat},${p.lng},${p.name}', p, kindIcon(p), recent: true)]);
      case _SearchTab.suggested:
        items.addAll([
          for (final p in saved) _PlaceItem('saved:${p.id}', p.place, savedIcon(p), subtitle: p.address),
          for (final p in (commonPlaces[city.id] ?? const <Place>[]).take(8)) _PlaceItem('common:${p.name}', p, kindIcon(p)),
        ]);
      case null:
        final common = (commonPlaces[city.id] ?? const <Place>[]).where(match).take(8).toList();
        final remote = s.remoteFor.toLowerCase() == q ? s.remote.where((r) => !common.any((x) => x.name == r.name)).toList() : const <Place>[];
        items.addAll([
          for (final p in saved.where((p) => match(p.place))) _PlaceItem('saved:${p.id}', p.place, savedIcon(p), subtitle: p.address),
          for (final p in recent.where(match).take(8)) _PlaceItem('recent:${p.lat},${p.lng},${p.name}', p, kindIcon(p), recent: true),
          for (final p in common) _PlaceItem('common:${p.name}', p, kindIcon(p)),
          for (final p in remote) _PlaceItem('found:${p.lat},${p.lng},${p.name}', p, kindIcon(p)),
        ]);
    }
    final nothing = tab == null && items.isEmpty && !s.searching && !s.searchDown;

    Widget row(_PlaceItem it) {
      final isSaved = savedAt(saved, it.place) != null;
      final tile = ListRowTile(
        key: ValueKey(it.key),
        leading: CircleIcon(it.icon),
        title: it.place.name,
        subtitle: it.subtitle ?? it.place.label,
        value: distance(it.place),
        divider: true,
        padding: const EdgeInsets.symmetric(vertical: 14),
        trailing: IconButton(
          tooltip: isSaved ? l.grUnsavePlace : l.grSavePlace,
          visualDensity: VisualDensity.compact,
          onPressed: () => toggleSaved(context, ref, it.place),
          icon: Icon(isSaved ? Icons.bookmark_rounded : Icons.bookmark_border_rounded, color: isSaved ? c.accentText : c.text, size: 22),
        ),
        onTap: () => pickRoutePlace(context, ref, it.place),
      );
      if (!it.recent) return tile;
      return Dismissible(
        key: ValueKey('dismiss:${it.key}'),
        direction: DismissDirection.endToStart,
        background: Container(alignment: AlignmentDirectional.centerEnd, padding: const EdgeInsetsDirectional.only(end: 20), child: Icon(Icons.delete_outline_rounded, color: c.danger)),
        onDismissed: (_) => ref.read(bookingProvider.notifier).forget(it.place),
        child: tile,
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (s.searching) const Padding(padding: EdgeInsets.only(top: 8), child: SkeletonList(rows: 3)),
        for (final it in items) row(it),
        if (tab == _SearchTab.recent && items.isEmpty)
          Padding(padding: const EdgeInsets.symmetric(vertical: 24), child: Text(l.grNoRecent, textAlign: TextAlign.center, style: AnbessaType.body2.copyWith(color: c.muted))),
        if (nothing) IllustratedEmpty(illustration: AnbessaIllustration.searchEmpty, title: l.noResults, compact: true),
      ],
    );
  }
}

/// The sheet of "Select from map" (the kit's "Set pickup location"): the place under the pin,
/// looked up as the map settles, ✎ back to the search, and Next.
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
          Semantics(header: true, child: Text(p.pickup ? l.grSetPickupLocation : l.grSetDestination, style: AnbessaType.h2.copyWith(color: c.text))),
          Divider(height: 25, color: c.border),
          if (p.error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Problem(p.error, describe: (e) => describeError(l, e))),
          Row(
            children: [
              CircleIcon(p.place == null ? Icons.location_on_outlined : (p.place!.category == null ? Icons.location_on_outlined : placeIcon(p.place!.category, p.place!.type))),
              const SizedBox(width: 14),
              Expanded(
                child: AnimatedSwitcherX(
                  alignment: Alignment.centerLeft,
                  child: busy
                      ? const Column(key: ValueKey('busy'), crossAxisAlignment: CrossAxisAlignment.start, children: [Skeleton.line(width: 180, height: 18), SizedBox(height: 6), Skeleton.line(width: 120, height: 12)])
                      : Column(
                          key: ValueKey('place:${p.place?.name}'),
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(p.place?.name ?? '—', style: AnbessaType.title.copyWith(color: c.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                            if ((p.place?.label ?? '').isNotEmpty) ...[
                              const SizedBox(height: 4),
                              Text(p.place!.label!, style: AnbessaType.caption.copyWith(color: c.muted), maxLines: 1, overflow: TextOverflow.ellipsis),
                            ],
                          ],
                        ),
                ),
              ),
              IconButton(tooltip: l.edit, icon: Icon(Icons.edit_outlined, color: c.text), onPressed: () => ref.read(pinPickerProvider.notifier).close()),
            ],
          ),
          Divider(height: 25, color: c.border),
          const SizedBox(height: 4),
          PrimaryButton(
            key: const ValueKey('pin-confirm'),
            label: l.next,
            onPressed: busy || p.place == null ? null : () => pickRoutePlace(context, ref, p.place!),
          ),
        ],
      ),
    );
  }
}
