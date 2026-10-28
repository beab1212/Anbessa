// Help (workflow 13): the person's support requests and lost-item reports, "Contact support"
// (a category, optionally a trip, and a message), and one request's thread with replies and
// reopening within 7 days of the answer.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/router/routes.dart';
import '../../core/session/session_controller.dart';
import '../../core/ux/kit_group.dart';
import '../config/client_config_provider.dart';
import '../rider/history/history_screens.dart';
import '../rider/trip/active_trip_controller.dart';
import 'support_repository.dart';
import 'support_widgets.dart';

/// "#1042 · Payment · updated 26 Oct, 15:00"
String _ticketLine(BuildContext context, Ticket t) {
  final l = context.l10n;
  return '#${t.ref} · ${ticketCategoryLabel(l, t.category)} · ${l.supportUpdated(dayAndTime(t.updatedAt, locale: context.localeTag))}';
}

String _short(String s, [int max = 80]) {
  final line = s.trim().split('\n').first.trim();
  return line.length <= max ? line : '${line.substring(0, max - 1).trimRight()}…';
}

class SupportScreen extends ConsumerWidget {
  const SupportScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final c = context.colors;
    final tickets = ref.watch(myTicketsProvider);
    // the rider's own reports; drivers find theirs under Account → Lost items
    final lost = (ref.watch(myLostItemsProvider).value ?? const <LostItem>[]).where((i) => i.isRider).toList();
    Future<void> refresh() async {
      ref.invalidate(myTicketsProvider);
      ref.invalidate(myLostItemsProvider);
      try {
        await ref.read(myTicketsProvider.future);
      } catch (_) {}
    }

    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.support),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 32),
          children: [
            // the kit's "Have a promo code?"-style lead card: what this is, and the way in
            AppCard(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const KitRowIcon(Icons.support_agent_rounded),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(l.actHelpTitle, style: AnbessaType.title.copyWith(color: c.text)),
                            const SizedBox(height: 4),
                            Text(l.supportLede, style: AnbessaType.caption.copyWith(color: c.muted)),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  PillButton(label: l.newTicket, icon: Icons.add_comment_outlined, onPressed: () => context.push(Routes.supportNew)),
                ],
              ),
            ),
            const SizedBox(height: 24),
            ...tickets.when(
              loading: () => const [SkeletonList(rows: 3, avatar: false)],
              error: (e, _) => [Problem(e, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(myTicketsProvider), retryLabel: l.retry)],
              data: (list) => [
                if (list.isEmpty && lost.isEmpty) IllustratedEmpty(illustration: AnbessaIllustration.searchEmpty, title: l.supportEmptyTitle, body: l.supportEmptyBody, compact: true),
                if (list.isNotEmpty) ...[
                  KitGroup(
                    title: l.supportYourRequests,
                    children: [
                      for (final t in list)
                        ListRowTile(
                          leading: const KitRowIcon(Icons.chat_bubble_outline_rounded),
                          title: t.subject,
                          subtitle: _ticketLine(context, t),
                          valueSub: ticketStatusLabel(l, t.status), valueSubColor: kitToneText(context, ticketStatusTone(t.status)),
                          onTap: () => context.push(Routes.supportTicket(t.id)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 20),
                ],
              ],
            ),
            if (lost.isNotEmpty) ...[
              KitGroup(
                title: l.lostItems,
                children: [
                  for (final i in lost)
                    ListRowTile(
                      leading: const KitRowIcon(Icons.backpack_outlined),
                      title: _short(i.description, 60),
                      subtitle: l.lostReportedOn(dayAndTime(i.createdAt, locale: context.localeTag)),
                      valueSub: lostItemStatusLabel(l, i.status), valueSubColor: kitToneText(context, lostItemStatusTone(i.status)),
                      onTap: () => context.push(Routes.lostItem(i.id)),
                    ),
                ],
              ),
              const SizedBox(height: 20),
            ],
            Notice(l.supportEmergencyNote, tone: NoticeTone.warning),
          ],
        ),
      ),
    );
  }
}

class NewTicketScreen extends ConsumerStatefulWidget {
  const NewTicketScreen({super.key, this.tripId});
  /// preselected trip (from a receipt)
  final String? tripId;
  @override
  ConsumerState<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends ConsumerState<NewTicketScreen> {
  final _text = TextEditingController();
  TicketCategory? _category;
  late String? _tripId = widget.tripId;
  bool _busy = false;
  // one key per distinct request: a retry of the same words reuses it, an edit gets a new one
  String? _key;
  String? _keyFor;

  @override
  void initState() {
    super.initState();
    if (widget.tripId != null) _category = TicketCategory.trip;
    _text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _ready => _category != null && _text.text.trim().length >= 5 && !_busy;

  Future<void> _submit() async {
    final category = _category!;
    final message = _text.text.trim();
    final sig = '${category.name}|$_tripId|$message';
    if (_keyFor != sig) {
      _key = newIdempotencyKey();
      _keyFor = sig;
    }
    final session = ref.read(currentSessionProvider);
    final driverSide = ref.read(effectiveModeProvider) == AppMode.driver && (session?.claims.hasRole('DRIVER') ?? false);
    setState(() {
      _busy = true;
    });
    try {
      final t = await ref.read(supportRepositoryProvider).open(
            category: category,
            subject: _short(message),
            message: message,
            tripId: _tripId,
            cityId: _tripId == null ? ref.read(currentCityProvider).id : null,
            as: _tripId == null ? (driverSide ? 'DRIVER' : 'RIDER') : null,
            idempotencyKey: _key!,
          );
      ref.invalidate(myTicketsProvider);
      Haptics.success();
      if (mounted) context.replace(Routes.supportTicket(t.id));
    } catch (e) {
      Haptics.error();
      if (mounted) {
        showWhoops(context, describeError(context.l10n, e));
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _pickTrip() async {
    final as = ref.read(effectiveModeProvider) == AppMode.driver ? 'driver' : 'rider';
    final picked = await showHandleSheet<String>(context, title: context.l10n.ticketPickTrip, builder: (ctx) => _TripPicker(as: as, selected: _tripId));
    if (picked == null || !mounted) return;
    setState(() => _tripId = picked.isEmpty ? null : picked);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final trip = _tripId == null ? null : ref.watch(tripProvider(_tripId!)).value;
    final tripLabel = _tripId == null ? l.ticketNoTrip : (trip == null ? '…' : _tripLabel(context, trip));
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: l.newTicket),
      bottomNavigationBar: BottomActionBar(child: PillButton(label: l.send, busy: _busy, onPressed: _ready ? _submit : null)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
        children: [
          Text(l.ticketWhatAbout, style: AnbessaType.title.copyWith(color: c.text)),
          const SizedBox(height: 12),
          for (final cat in ticketCategoriesForApp)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: SelectableCard(
                selected: _category == cat,
                onTap: () => setState(() => _category = cat),
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                child: Row(
                  children: [
                    KitRowIcon(ticketCategoryIcon(cat), color: cat == TicketCategory.safety ? c.danger : null),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(ticketCategoryLabel(l, cat), style: AnbessaType.title.copyWith(color: c.text)),
                          if (ticketCategoryHint(l, cat).isNotEmpty) Text(ticketCategoryHint(l, cat), style: AnbessaType.caption.copyWith(color: c.muted)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (_category == TicketCategory.safety) ...[const SizedBox(height: 6), Notice(l.ticketSafetyNotice, tone: NoticeTone.warning)],
          const SizedBox(height: 8),
          Text(l.ticketLostItemHint, style: AnbessaType.caption.copyWith(color: c.muted)),
          const SizedBox(height: 24),
          FieldLabel(l.ticketTripLabel),
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            color: c.field,
            border: false,
            child: ListRowTile(leading: const KitRowIcon(Icons.route_outlined), title: tripLabel, chevron: true, onTap: _pickTrip),
          ),
          const SizedBox(height: 24),
          FilledField(label: l.ticketMessageLabel, hint: l.ticketMessageHint, controller: _text, maxLines: 6, maxLength: 5000, textCapitalization: TextCapitalization.sentences),
        ],
      ),
    );
  }
}

String _tripLabel(BuildContext context, Trip t) => '${dayAndTime(t.times.requestedAt, locale: context.localeTag)} · ${t.dropoff.address ?? '—'}';

/// Recent trips to attach to a request; returns the trip id, or '' for "not about a trip".
class _TripPicker extends ConsumerWidget {
  const _TripPicker({required this.as, required this.selected});
  final String as;
  final String? selected;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = context.l10n;
    final history = ref.watch(tripHistoryProvider(as));
    final trips = (history.value?.trips ?? const <Trip>[]).take(10).toList();
    final c = context.colors;
    Widget check(bool on) => on ? Icon(Icons.check_circle_rounded, color: c.accent) : const SizedBox(width: 24);
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.7),
      child: ListView(
        shrinkWrap: true,
        children: [
          ListRowTile(leading: const KitRowIcon(Icons.do_not_disturb_on_outlined), title: l.ticketNoTrip, trailing: check(selected == null), divider: true, onTap: () => Navigator.pop(context, '')),
          for (final t in trips)
            ListRowTile(
              leading: KitRowIcon(vehicleIcon(t.vehicleType)),
              title: t.dropoff.address ?? '—',
              subtitle: '${dayAndTime(t.times.requestedAt, locale: context.localeTag)} · ${tripStatusLabel(l, t.status)}',
              trailing: check(selected == t.id),
              divider: true,
              onTap: () => Navigator.pop(context, t.id),
            ),
          if (history.isLoading) const Padding(padding: EdgeInsets.only(top: 12), child: SkeletonList(rows: 2, avatar: false)),
          if (history.hasError) Padding(padding: const EdgeInsets.only(top: 12), child: Problem(history.error, describe: (e) => describeError(l, e))),
        ],
      ),
    );
  }
}

class TicketScreen extends ConsumerStatefulWidget {
  const TicketScreen({super.key, required this.ticketId});
  final String ticketId;
  @override
  ConsumerState<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends ConsumerState<TicketScreen> {
  Object? _actionError;
  bool _busy = false;

  Future<void> _reopen() async {
    final text = await showDialog<String>(context: context, builder: (_) => const _ReopenDialog());
    if (text == null || text.isEmpty || !mounted) return;
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await ref.read(ticketThreadProvider(widget.ticketId).notifier).reopen(text);
    } catch (e) {
      _actionError = e;
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final async = ref.watch(ticketThreadProvider(widget.ticketId));
    final thread = async.value;
    if (thread == null) {
      return Scaffold(
        backgroundColor: c.page,
        appBar: AppTopBar(title: l.support),
        body: Padding(
          padding: const EdgeInsets.all(AnbessaSpace.page),
          child: async.hasError
              ? Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(ticketThreadProvider(widget.ticketId)), retryLabel: l.retry)
              : const SkeletonList(rows: 4, avatar: false),
        ),
      );
    }
    final t = thread.ticket;
    final now = DateTime.now();
    return Scaffold(
      backgroundColor: c.page,
      appBar: AppTopBar(title: '#${t.ref}'),
      body: Column(
        children: [
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                try {
                  await ref.read(ticketThreadProvider(widget.ticketId).notifier).refresh();
                } catch (_) {}
              },
              child: ListView(
                padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 4, AnbessaSpace.page, 24),
                children: [
                  Text(t.subject, style: AnbessaType.h2.copyWith(color: c.text)),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      StatusPill(ticketStatusLabel(l, t.status), tone: ticketStatusTone(t.status)),
                      Text('${ticketCategoryLabel(l, t.category)} · ${dayAndTime(t.createdAt, locale: context.localeTag)}', style: AnbessaType.caption.copyWith(color: c.muted)),
                    ],
                  ),
                  const SizedBox(height: 16),
                  if (t.status == TicketStatus.waitingRequester) ...[Notice(l.ticketWaitingYouLede, tone: NoticeTone.warning), const SizedBox(height: 12)],
                  if (t.resolutionNote != null && (t.status == TicketStatus.resolved || t.status == TicketStatus.closed)) ...[
                    AppCard(
                      color: c.selectedFill,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(children: [Icon(Icons.verified_outlined, size: 20, color: c.accentText), const SizedBox(width: 8), Text(l.ticketAnswer, style: AnbessaType.title.copyWith(color: c.text))]),
                          const SizedBox(height: 8),
                          Text(t.resolutionNote!, style: AnbessaType.body2.copyWith(color: c.text)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  ThreadMessage(author: l.threadYou, body: t.description, at: t.createdAt, mine: true),
                  for (final m in thread.messages)
                    ThreadMessage(
                      author: m.author == TicketAuthor.requester ? l.threadYou : l.threadSupport,
                      body: m.body,
                      at: m.createdAt,
                      mine: m.author == TicketAuthor.requester,
                      system: m.author == TicketAuthor.system,
                    ),
                  const SizedBox(height: 16),
                  Problem(_actionError, describe: (e) => describeError(l, e)),
                  if (t.canReopen(now)) ...[
                    Text(l.ticketReopenLede, style: AnbessaType.caption.copyWith(color: c.muted)),
                    const SizedBox(height: 8),
                    PillButton(label: l.ticketReopen, variant: PillVariant.outline, busy: _busy, onPressed: _busy ? null : _reopen),
                  ] else if (!t.canReply) ...[
                    Notice(l.ticketClosedLede),
                    const SizedBox(height: 8),
                    PillButton(label: l.newTicket, variant: PillVariant.tonal, onPressed: () => context.push(Routes.supportNew)),
                  ],
                ],
              ),
            ),
          ),
          if (t.canReply) ReplyComposer(maxLength: 5000, onSend: (body) => ref.read(ticketThreadProvider(widget.ticketId).notifier).reply(body)),
        ],
      ),
    );
  }
}

/// Asks why the request is reopened; owns its text controller so it outlives the closing animation.
class _ReopenDialog extends StatefulWidget {
  const _ReopenDialog();
  @override
  State<_ReopenDialog> createState() => _ReopenDialogState();
}

class _ReopenDialogState extends State<_ReopenDialog> {
  final _reason = TextEditingController();

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    return AlertDialog(
      title: Text(l.ticketReopen),
      content: TextField(
        controller: _reason,
        autofocus: true,
        minLines: 2,
        maxLines: 4,
        maxLength: 2000,
        decoration: InputDecoration(hintText: l.ticketReopenHint, counterText: ''),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(l.cancel)),
        FilledButton(onPressed: () => Navigator.pop(context, _reason.text.trim()), child: Text(l.ticketReopen)),
      ],
    );
  }
}

/// The leading icon of a help-request category.
IconData ticketCategoryIcon(TicketCategory c) => switch (c) {
      TicketCategory.safety => Icons.shield_outlined,
      TicketCategory.payment => Icons.payments_outlined,
      TicketCategory.trip => Icons.local_taxi_outlined,
      TicketCategory.lostItem => Icons.backpack_outlined,
      TicketCategory.account => Icons.person_outline_rounded,
      TicketCategory.feedback => Icons.rate_review_outlined,
      TicketCategory.unknown => Icons.help_outline_rounded,
    };
