// Home, Work and the other saved places: set, change, remove.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/router/routes.dart';
import '../rider/places/saved_places_controller.dart';

class SavedPlacesScreen extends ConsumerStatefulWidget {
  const SavedPlacesScreen({super.key});
  @override
  ConsumerState<SavedPlacesScreen> createState() => _SavedPlacesScreenState();
}

class _SavedPlacesScreenState extends ConsumerState<SavedPlacesScreen> {
  Object? _error;

  Future<void> _pick(PlaceLabel label) async {
    final p = await context.push<Place>('${Routes.riderRoute}?mode=savedPlace&label=${label.name}');
    if (p == null || !mounted) return;
    try {
      if (label == PlaceLabel.other) {
        await ref.read(savedPlacesProvider.notifier).add(p);
      } else {
        await ref.read(savedPlacesProvider.notifier).setFixed(label, p);
      }
      Haptics.success();
      if (mounted) showToast(context, context.l10n.placeSaved, tone: NoticeTone.ok);
    } catch (e) {
      setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final places = ref.watch(savedPlacesProvider);
    final home = ref.watch(homePlaceProvider);
    final work = ref.watch(workPlaceProvider);
    final others = (places.value ?? const <SavedPlace>[]).where((p) => p.label == PlaceLabel.other).toList();
    return Scaffold(
      appBar: AppBar(title: Text(l.savedPlaces)),
      body: RefreshIndicator(
        onRefresh: () => ref.read(savedPlacesProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(l.savedPlacesLede, style: AnbessaType.body2.copyWith(color: c.text2)),
            const SizedBox(height: 16),
            Problem(_error, describe: (e) => describeError(l, e)),
            if (places.hasError) Problem(places.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(savedPlacesProvider.notifier).refresh(), retryLabel: l.retry),
            if (places.isLoading && places.value == null)
              const SkeletonList(rows: 2)
            else
              SectionGroup(
                children: [
                  SettingsValueTile(icon: Icons.home_rounded, title: l.savedHome, value: home?.name ?? l.notSet, onTap: () => _pick(PlaceLabel.home)),
                  SettingsValueTile(icon: Icons.work_rounded, title: l.savedWork, value: work?.name ?? l.notSet, onTap: () => _pick(PlaceLabel.work)),
                ],
              ),
            if (others.isNotEmpty)
              SectionGroup(
                title: l.savedPlacesHeader,
                children: [
                  for (final p in others)
                    Dismissible(
                      key: ValueKey(p.id),
                      direction: DismissDirection.endToStart,
                      background: Container(color: c.dangerSoft, alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: Icon(Icons.delete_outline, color: c.danger)),
                      onDismissed: (_) => ref.read(savedPlacesProvider.notifier).remove(p.id),
                      child: SettingsTile(icon: Icons.star_rounded, title: p.name, subtitle: p.address, chevron: false, trailing: IconButton(tooltip: l.removePlace, icon: const Icon(Icons.delete_outline), onPressed: () => ref.read(savedPlacesProvider.notifier).remove(p.id))),
                    ),
                ],
              ),
            OutlinedButton(onPressed: () => _pick(PlaceLabel.other), child: Text(l.addPlace)),
          ],
        ),
      ),
    );
  }
}
