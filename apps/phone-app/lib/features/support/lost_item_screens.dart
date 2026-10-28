// Lost items (workflow 13 §3): the rider reports from a completed trip's receipt ("I left
// something"), then follows the report and talks to the driver through support-service (no phone
// numbers change hands). The driver (or fleet owner) sees the reports about their trips under
// Account → Lost items, answers Found / Not found, and replies.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/ux/kit_group.dart';
import '../rider/history/history_screens.dart' show HairlineRouteCard;
import '../rider/trip/active_trip_controller.dart';
import 'support_repository.dart';
import 'support_widgets.dart';

String _short(String s, [int max = 60]) {
  final line = s.trim().split('\n').first.trim();
  return line.length <= max ? line : '${line.substring(0, max - 1).trimRight()}…';
}

class ReportLostItemScreen extends ConsumerStatefulWidget {
  const ReportLostItemScreen({super.key, required this.tripId});
  final String tripId;
  @override
  ConsumerState<ReportLostItemScreen> createState() => _ReportLostItemScreenState();
}

class _ReportLostItemScreenState extends ConsumerState<ReportLostItemScreen> {
  final _text = TextEditingController();
  bool _busy = false;
  String? _key;
  String? _keyFor;

  @override
  void initState() {
    super.initState();
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final description = _text.text.trim();
    if (_keyFor != description) {
      _key = newIdempotencyKey();
      _keyFor = description;
    }
    setState(() {
      _busy = true;
    });
    try {
      final item = await ref.read(supportRepositoryProvider).reportLostItem(tripId: widget.tripId, description: description, idempotencyKey: _key!);
      ref.invalidate(myLostItemsProvider);
      Haptics.success();
      if (mounted) context.replace(Routes.lostItem(item.id));
    } catch (e) {
      Haptics.error();
      if (mounted) {
        showWhoops(context, describeError(context.l10n, e));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final tripAsync = ref.watch(tripProvider(widget.tripId));
    final trip = tripAsync.value;
    final closed = trip != null && !lostItemReportable(trip, DateTime.now());
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.reportLostItem),
      bottomNavigationBar: BottomActionBar(child: PrimaryButton(label: l.lostSend, busy: _busy, onPressed: !closed && !_busy && _text.text.trim().length >= 3 ? _submit : null)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
        children: [
          Text(l.lostReportLede, style: AnbessaType.body2.copyWith(color: c.text2)),
          const SizedBox(height: 20),
          if (trip != null) ...[
            Text(l.lostTheTrip, style: AnbessaType.title.copyWith(color: c.text)),
            const SizedBox(height: 10),
            HairlineRouteCard(pickup: trip.pickup.address ?? l.pickupLabel, dropoff: trip.dropoff.address ?? l.dropoffLabel),
            const SizedBox(height: 12),
            KeyValueCard(rows: [KeyValueCard.row(l.lostTripWhen, dayAndTime(trip.times.completedAt ?? trip.times.requestedAt, locale: context.localeTag))]),
          ]
          else if (tripAsync.hasError)
            Problem(tripAsync.error, describe: (e) => describeError(l, e))
          else
            const SkeletonCard(height: 120),
          const SizedBox(height: 24),
          if (closed) ...[Notice(l.errorReportWindowClosed, tone: NoticeTone.warning), const SizedBox(height: 16)],
          FilledField(label: l.lostDescribeLabel, hint: l.lostDescribeHint, controller: _text, enabled: !closed, maxLines: 5, maxLength: 2000, textCapitalization: TextCapitalization.sentences),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.lock_outline_rounded, size: 16, color: c.muted),
              const SizedBox(width: 6),
              Expanded(child: Text(l.lostPrivacyNote, style: AnbessaType.caption.copyWith(color: c.muted))),
            ],
          ),
        ],
      ),
    );
  }
}

class LostItemScreen extends ConsumerStatefulWidget {
  const LostItemScreen({super.key, required this.lostItemId});
  final String lostItemId;
  @override
  ConsumerState<LostItemScreen> createState() => _LostItemScreenState();
}

class _LostItemScreenState extends ConsumerState<LostItemScreen> {
  final _note = TextEditingController();
  bool _busy = false;
  Object? _actionError;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  Future<void> _act(Future<void> Function(LostItemThreadController c) action) async {
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await action(ref.read(lostItemThreadProvider(widget.lostItemId).notifier));
      _note.clear();
      Haptics.success();
      // the kit's success sheet, with what happens next
      final item = ref.read(lostItemThreadProvider(widget.lostItemId)).value?.lostItem;
      if (mounted) showSuccessSheet(context, title: context.l10n.actSentTitle, message: item == null ? null : lostItemStatusLede(context.l10n, item));
    } catch (e) {
      Haptics.error();
      _actionError = e;
    }
    if (mounted) setState(() => _busy = false);
  }

  String? get _noteText => _note.text.trim().isEmpty ? null : _note.text.trim();

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final async = ref.watch(lostItemThreadProvider(widget.lostItemId));
    final thread = async.value;
    if (thread == null) {
      return Scaffold(
        backgroundColor: c.page,
        appBar: AppTopBar(title: l.lostItemTitle),
        body: Padding(
          padding: const EdgeInsets.all(AnbessaSpace.page),
          child: async.hasError
              ? Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(lostItemThreadProvider(widget.lostItemId)), retryLabel: l.retry)
              : const SkeletonList(rows: 4, avatar: false),
        ),
      );
    }
    final item = thread.lostItem;
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.lostItemTitle),
      body: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                try {
                  await ref.read(lostItemThreadProvider(widget.lostItemId).notifier).refresh();
                } catch (_) {}
              },
              child: ListView(
                padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
                children: [
                  // the headline card: the bag in a circle, what was left, its status
                  AppCard(
                    child: Column(
                      children: [
                        const KitRowIcon(Icons.backpack_outlined),
                        const SizedBox(height: 10),
                        Text(item.isRider ? l.lostWhatYouLeft : l.lostWhatRiderLeft, style: AnbessaType.caption.copyWith(color: c.muted)),
                        const SizedBox(height: 4),
                        Text(item.description, textAlign: TextAlign.center, style: AnbessaType.title.copyWith(color: c.text)),
                        const SizedBox(height: 6),
                        Text(l.lostReportedOn(dayAndTime(item.createdAt, locale: context.localeTag)), style: AnbessaType.caption.copyWith(color: c.muted)),
                        const SizedBox(height: 10),
                        StatusPill(lostItemStatusLabel(l, item.status), tone: lostItemStatusTone(item.status)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(lostItemStatusLede(l, item), style: AnbessaType.body2.copyWith(color: c.text2)),
                  const SizedBox(height: 16),
                  Problem(_actionError, describe: (e) => describeError(l, e)),
                  if (item.canConfirmReturned) ...[
                    PrimaryButton(label: l.lostConfirmReturned, busy: _busy, onPressed: _busy ? null : () => _act((n) => n.confirmReturned())),
                    const SizedBox(height: 16),
                  ],
                  if (item.canAnswerFound || item.canAnswerNotFound) ...[
                    FilledField(label: l.lostNoteLabel, hint: l.lostNoteHint, controller: _note, maxLines: 3, textCapitalization: TextCapitalization.sentences),
                    const SizedBox(height: 16),
                    if (item.canAnswerFound) PrimaryButton(label: l.lostAnswerFound, busy: _busy, onPressed: _busy ? null : () => _act((n) => n.answer(found: true, note: _noteText))),
                    if (item.canAnswerFound && item.canAnswerNotFound) const SizedBox(height: 12),
                    if (item.canAnswerNotFound) PillButton(label: l.lostAnswerNotFound, variant: PillVariant.outlineNeutral, onPressed: _busy ? null : () => _act((n) => n.answer(found: false, note: _noteText))),
                    const SizedBox(height: 16),
                  ],
                  if (thread.messages.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(l.threadMessages, style: AnbessaType.title.copyWith(color: c.text))),
                  for (final m in thread.messages)
                    ThreadMessage(author: lostItemAuthorLabel(l, m.author, item.viewerRole), body: m.body, at: m.createdAt, mine: m.author == item.viewerRole),
                ],
              ),
            ),
          ),
          if (item.canMessage) ReplyComposer(onSend: (body) => ref.read(lostItemThreadProvider(widget.lostItemId).notifier).reply(body)),
        ],
      ),
    );
  }
}

/// Account → Lost items (driver mode): reports about trips the person drove, or about their
/// fleet's cars.
class DriverLostItemsScreen extends ConsumerWidget {
  const DriverLostItemsScreen({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final async = ref.watch(myLostItemsProvider);
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.lostItems),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(myLostItemsProvider);
          try {
            await ref.read(myLostItemsProvider.future);
          } catch (_) {}
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 32),
          children: [
            Text(l.driverLostItemsLede, style: AnbessaType.body2.copyWith(color: c.text2)),
            const SizedBox(height: 16),
            ...async.when(
              loading: () => const [SkeletonList(rows: 3, avatar: false)],
              error: (e, _) => [Problem(e, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(myLostItemsProvider), retryLabel: l.retry)],
              data: (all) {
                final list = all.where((i) => i.isDriverSide).toList();
                if (list.isEmpty) return [IllustratedEmpty(illustration: AnbessaIllustration.searchEmpty, title: l.driverLostItemsEmpty, compact: true)];
                return [
                  KitGroup(
                    children: [
                      for (final i in list)
                        ListRowTile(
                          leading: const KitRowIcon(Icons.backpack_outlined),
                          title: _short(i.description),
                          subtitle: l.lostReportedOn(dayAndTime(i.createdAt, locale: context.localeTag)),
                          valueSub: lostItemStatusLabel(l, i.status), valueSubColor: kitToneText(context, lostItemStatusTone(i.status)),
                          onTap: () => context.push(Routes.lostItem(i.id)),
                        ),
                    ],
                  ),
                ];
              },
            ),
          ],
        ),
      ),
    );
  }
}
