// Saved Addresses (the kit's pp. 156–161): a card per place (amber pin, name, share and ⋮, a
// hairline, the address), Edit / Delete from the ⋮ menu, a Delete Address confirmation, an
// "Address deleted!" snack bar with Undo, and "+ Add Address" pinned at the bottom. A new place
// is picked on the full-screen map picker, then named in the "Add an Address" sheet (p. 157).

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import 'package:share_plus/share_plus.dart';
import '../../core/l10n/l10n.dart';
import '../../core/router/routes.dart';
import '../rider/places/saved_places_controller.dart';

/// Pick a place on the full-screen picker and save it as [label]; the error when saving failed.
Future<Object?> pickAndSavePlace(BuildContext context, WidgetRef ref, PlaceLabel label) async {
  final p = await context.push<Place>(Routes.pickSavedPlace(label.name));
  if (p == null || !context.mounted) return null;
  try {
    if (label == PlaceLabel.other) {
      await ref.read(savedPlacesProvider.notifier).add(p);
    } else {
      await ref.read(savedPlacesProvider.notifier).setFixed(label, p);
    }
    Haptics.success();
    if (context.mounted) showToast(context, context.l10n.placeSaved, tone: NoticeTone.ok);
    return null;
  } catch (e) {
    return e;
  }
}

class SavedPlacesScreen extends ConsumerStatefulWidget {
  const SavedPlacesScreen({super.key});
  @override
  ConsumerState<SavedPlacesScreen> createState() => _SavedPlacesScreenState();
}

/// What the "Add an Address" sheet hands back.
typedef _Draft = ({String name, String details, bool repick});

class _SavedPlacesScreenState extends ConsumerState<SavedPlacesScreen> {
  Object? _error;

  /// Pick (or keep) a location, name it in the sheet, save it. [existing] is the place being
  /// edited; Home and Work keep their label.
  Future<void> _addOrEdit(PlaceLabel label, {SavedPlace? existing}) async {
    final l = context.l10n;
    Place? place = existing?.place;
    var name = existing?.name ?? '';
    var details = '';
    while (mounted) {
      if (place == null) {
        if (!mounted) return;
        place = await context.push<Place>(Routes.pickSavedPlace(label.name));
        if (place == null || !mounted) return;
        if (name.isEmpty) name = label == PlaceLabel.home ? l.savedHome : label == PlaceLabel.work ? l.savedWork : place.name;
      }
      final picked = place;
      if (!mounted) return;
      final r = await showModalBottomSheet<_Draft>(
        context: context,
        isScrollControlled: true,
        showDragHandle: false,
        builder: (_) => _AddAddressSheet(place: picked, fixedLabel: label != PlaceLabel.other, name: name, details: details),
      );
      if (r == null || !mounted) return;
      name = r.name;
      details = r.details;
      if (r.repick) {
        place = null;
        continue;
      }
      final address = [if ((picked.label ?? '').isNotEmpty) picked.label!, if (details.isNotEmpty) details].join(', ');
      final toSave = picked.copyWith(name: name.isEmpty ? picked.name : name, label: address.isEmpty ? null : address);
      setState(() => _error = null);
      try {
        final ctrl = ref.read(savedPlacesProvider.notifier);
        if (label == PlaceLabel.other) {
          await ctrl.add(toSave);
          // there is no update: the edited place replaces the old one
          if (existing != null) await ctrl.remove(existing.id);
        } else {
          await ctrl.setFixed(label, toSave);
        }
        Haptics.success();
        if (mounted) showToast(context, l.placeSaved, tone: NoticeTone.ok);
      } catch (e) {
        if (mounted) setState(() => _error = e);
      }
      return;
    }
  }

  Future<void> _delete(SavedPlace p, String title) async {
    final l = context.l10n;
    final yes = await showConfirmSheet(
      context,
      title: l.accDeleteAddress,
      message: l.accDeleteAddressConfirm,
      confirmLabel: l.accYesDelete,
      cancelLabel: l.cancel,
      destructive: true,
      child: _AddressCard(title: title, address: p.address, compact: true),
    );
    if (!yes || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    final ctrl = ref.read(savedPlacesProvider.notifier);
    try {
      await ctrl.remove(p.id);
    } catch (e) {
      if (mounted) setState(() => _error = e);
      return;
    }
    Haptics.success();
    if (!mounted) return;
    final c = context.colors;
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(
      duration: const Duration(seconds: 5),
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      content: Row(
        children: [
          ExcludeSemantics(child: Icon(Icons.check_circle_rounded, color: c.accent, size: 24)),
          const SizedBox(width: 12),
          Expanded(child: Text(l.accAddressDeleted, style: AnbessaType.body.copyWith(color: c.text))),
          PillButton(
            label: l.accUndo,
            compact: true,
            onPressed: () async {
              messenger.hideCurrentSnackBar();
              try {
                if (p.label == PlaceLabel.home || p.label == PlaceLabel.work) {
                  await ctrl.setFixed(p.label, p.place);
                } else {
                  await ctrl.add(p.place);
                }
              } catch (e) {
                if (mounted) setState(() => _error = e);
              }
            },
          ),
        ],
      ),
    ));
  }

  void _share(String title, SavedPlace p) {
    final l = context.l10n;
    SharePlus.instance.share(ShareParams(text: l.accShareAddressText(title, p.address ?? p.name, 'https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}'), subject: title));
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final places = ref.watch(savedPlacesProvider);
    final home = ref.watch(homePlaceProvider);
    final work = ref.watch(workPlaceProvider);
    final others = (places.value ?? const <SavedPlace>[]).where((p) => p.label == PlaceLabel.other).toList();

    Widget card(PlaceLabel label, SavedPlace? p, String title) => Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: _AddressCard(
            title: title,
            address: p == null ? l.accTapToSet : (p.address ?? p.name),
            muted: p == null,
            onTap: p == null ? () => _addOrEdit(label) : null,
            actions: p == null
                ? [IconButton(tooltip: l.accAddAddress, icon: const Icon(Icons.add_rounded), onPressed: () => _addOrEdit(label))]
                : [
                    IconButton(tooltip: l.accShare, icon: const Icon(Icons.share_outlined, size: 22), onPressed: () => _share(title, p)),
                    PopupMenuButton<String>(
                      tooltip: MaterialLocalizations.of(context).showMenuTooltip,
                      icon: const Icon(Icons.more_vert_rounded),
                      onSelected: (v) => v == 'edit' ? _addOrEdit(label, existing: p) : _delete(p, title),
                      itemBuilder: (_) => [
                        PopupMenuItem(value: 'edit', child: Row(children: [Icon(Icons.edit_outlined, size: 20, color: c.text), const SizedBox(width: 12), Text(l.edit)])),
                        PopupMenuItem(value: 'delete', child: Row(children: [Icon(Icons.delete_outline_rounded, size: 20, color: c.danger), const SizedBox(width: 12), Text(l.accDelete, style: TextStyle(color: c.danger))])),
                      ],
                    ),
                  ],
          ),
        );

    return Scaffold(
      backgroundColor: c.groupedPage,
      appBar: AppTopBar(title: l.accSavedAddresses, background: c.groupedPage),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => ref.read(savedPlacesProvider.notifier).refresh(),
              child: ListView(
                padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 12, AnbessaSpace.page, 32),
                children: [
                  Problem(_error, describe: (e) => describeError(l, e)),
                  if (places.hasError) Problem(places.error, describe: (e) => describeError(l, e), onRetry: () => ref.read(savedPlacesProvider.notifier).refresh(), retryLabel: l.retry),
                  if (places.isLoading && places.value == null)
                    const SkeletonList(rows: 3)
                  else ...[
                    card(PlaceLabel.home, home, l.savedHome),
                    card(PlaceLabel.work, work, l.savedWork),
                    for (final p in others) card(PlaceLabel.other, p, p.name),
                  ],
                ],
              ),
            ),
          ),
          BottomActionBar(child: PillButton(label: l.accAddAddress, icon: Icons.add_rounded, onPressed: () => _addOrEdit(PlaceLabel.other))),
        ],
      ),
    );
  }
}

/// The kit's address card: the amber pin and the bold name with the actions, a hairline, the
/// address.
class _AddressCard extends StatelessWidget {
  const _AddressCard({required this.title, this.address, this.actions = const [], this.onTap, this.muted = false, this.compact = false});
  final String title;
  final String? address;
  final List<Widget> actions;
  final VoidCallback? onTap;
  final bool muted;
  /// inside the delete confirmation: smaller, no actions
  final bool compact;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AppCard(
      onTap: onTap,
      padding: EdgeInsetsDirectional.fromSTEB(16, compact ? 12 : 6, actions.isEmpty ? 16 : 4, compact ? 12 : 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ExcludeSemantics(child: Icon(Icons.location_on_rounded, size: 22, color: c.accent)),
              const SizedBox(width: 10),
              Expanded(child: Padding(padding: EdgeInsets.symmetric(vertical: actions.isEmpty ? 0 : 12), child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.title.copyWith(color: c.text)))),
              ...actions,
            ],
          ),
          if (!compact) Padding(padding: EdgeInsetsDirectional.only(end: actions.isEmpty ? 0 : 12), child: Divider(height: 8, color: c.border)),
          SizedBox(height: compact ? 8 : 10),
          Padding(
            padding: EdgeInsetsDirectional.only(end: actions.isEmpty ? 0 : 12),
            child: Text(address ?? '—', style: AnbessaType.body2.copyWith(color: muted ? c.muted : c.text2, fontWeight: FontWeight.w400)),
          ),
        ],
      ),
    );
  }
}

/// "Add an Address" (p. 157): the picked place in a card (tap it to choose again on the map),
/// Name, Address Details, Cancel | Save Address.
class _AddAddressSheet extends StatefulWidget {
  const _AddAddressSheet({required this.place, required this.fixedLabel, required this.name, required this.details});
  final Place place;
  /// Home or Work: the name stays
  final bool fixedLabel;
  final String name;
  final String details;
  @override
  State<_AddAddressSheet> createState() => _AddAddressSheetState();
}

class _AddAddressSheetState extends State<_AddAddressSheet> {
  late final _name = TextEditingController(text: widget.name);
  late final _details = TextEditingController(text: widget.details);

  @override
  void dispose() {
    _name.dispose();
    _details.dispose();
    super.dispose();
  }

  _Draft _draft({bool repick = false}) => (name: _name.text.trim(), details: _details.text.trim(), repick: repick);

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    return HandleSheet(
      title: l.accAddAnAddress,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Semantics(
              button: true,
              hint: l.accChangeOnMap,
              child: AppCard(
                onTap: () => Navigator.of(context).pop(_draft(repick: true)),
                padding: const EdgeInsets.all(14),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ExcludeSemantics(child: Icon(Icons.location_on_rounded, size: 22, color: c.danger)),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(widget.place.name, style: AnbessaType.title.copyWith(color: c.text)),
                          if ((widget.place.label ?? '').isNotEmpty) ...[const SizedBox(height: 6), Text(widget.place.label!, style: AnbessaType.body2.copyWith(color: c.text2, fontWeight: FontWeight.w400))],
                        ],
                      ),
                    ),
                    ExcludeSemantics(child: Icon(Icons.edit_location_alt_outlined, size: 20, color: c.muted)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),
            if (!widget.fixedLabel) ...[
              FilledField(label: l.accName, hint: l.accNameHint, controller: _name, textCapitalization: TextCapitalization.sentences),
              const SizedBox(height: 20),
            ],
            FilledField(label: l.accAddressDetails, hint: l.accAddressDetailsHint, controller: _details, textCapitalization: TextCapitalization.sentences),
            const SizedBox(height: 24),
            PillButtonPair(
              first: PillButton(label: l.cancel, variant: PillVariant.tonal, onPressed: () => Navigator.of(context).pop()),
              second: PillButton(label: l.accSaveAddress, onPressed: () => Navigator.of(context).pop(_draft())),
            ),
          ],
        ),
      ),
    );
  }
}
