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
      appBar: AppBar(title: Text(l.support)),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          children: [
            Text(l.supportLede, style: AnbessaType.body.copyWith(color: c.text2)),
            const SizedBox(height: 16),
            PrimaryButton(label: l.newTicket, onPressed: () => context.push(Routes.supportNew)),
            const SizedBox(height: 24),
            ...tickets.when(
              loading: () => const [SkeletonList(rows: 3, avatar: false)],
              error: (e, _) => [Problem(e, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(myTicketsProvider), retryLabel: l.retry)],
              data: (list) => [
                if (list.isEmpty && lost.isEmpty) IllustratedEmpty(illustration: AnbessaIllustration.searchEmpty, title: l.supportEmptyTitle, body: l.supportEmptyBody, compact: true),
                if (list.isNotEmpty)
                  SectionGroup(
                    title: l.supportYourRequests,
                    children: [
                      for (final t in list)
                        SettingsTile(
                          icon: Icons.chat_bubble_outline,
                          title: t.subject,
                          subtitle: _ticketLine(context, t),
                          trailing: StatusPill(ticketStatusLabel(l, t.status), tone: ticketStatusTone(t.status)),
                          onTap: () => context.push(Routes.supportTicket(t.id)),
                        ),
                    ],
                  ),
              ],
            ),
            if (lost.isNotEmpty)
              SectionGroup(
                title: l.lostItems,
                children: [
                  for (final i in lost)
                    SettingsTile(
                      icon: Icons.backpack_outlined,
                      title: _short(i.description, 60),
                      subtitle: l.lostReportedOn(dayAndTime(i.createdAt, locale: context.localeTag)),
                      trailing: StatusPill(lostItemStatusLabel(l, i.status), tone: lostItemStatusTone(i.status)),
                      onTap: () => context.push(Routes.lostItem(i.id)),
                    ),
                ],
              ),
            Text(l.supportEmergencyNote, style: AnbessaType.caption.copyWith(color: c.muted)),
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
  Object? _error;
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
      _error = null;
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
      if (mounted) setState(() => _error = e);
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _pickTrip() async {
    final as = ref.read(effectiveModeProvider) == AppMode.driver ? 'driver' : 'rider';
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (ctx) => _TripPicker(as: as, selected: _tripId),
    );
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
      appBar: AppBar(title: Text(l.newTicket)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        children: [
          SectionGroup(
            title: l.ticketWhatAbout,
            children: [
              for (final cat in ticketCategoriesForApp)
                ChoiceRow(title: ticketCategoryLabel(l, cat), subtitle: ticketCategoryHint(l, cat), selected: _category == cat, onTap: () => setState(() => _category = cat)),
            ],
          ),
          if (_category == TicketCategory.safety) ...[Notice(l.ticketSafetyNotice, tone: NoticeTone.warning), const SizedBox(height: 16)],
          Text(l.ticketLostItemHint, style: AnbessaType.caption.copyWith(color: c.muted)),
          const SizedBox(height: 16),
          SectionGroup(
            title: l.ticketTrip,
            children: [SettingsValueTile(icon: Icons.route_outlined, title: l.ticketTripLabel, value: tripLabel, onTap: _pickTrip)],
          ),
          TextField(
            controller: _text,
            minLines: 5,
            maxLines: 10,
            maxLength: 5000,
            textCapitalization: TextCapitalization.sentences,
            decoration: InputDecoration(labelText: l.ticketMessageLabel, hintText: l.ticketMessageHint, alignLabelWithHint: true),
          ),
          const SizedBox(height: 8),
          Problem(_error, describe: (e) => describeError(l, e)),
          const SizedBox(height: 8),
          PrimaryButton(label: l.send, busy: _busy, onPressed: _ready ? _submit : null),
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
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            Text(l.ticketPickTrip, style: AnbessaType.title.copyWith(color: context.colors.text)),
            const SizedBox(height: 12),
            SectionGroup(
              margin: EdgeInsets.zero,
              children: [
                ChoiceRow(title: l.ticketNoTrip, selected: selected == null, onTap: () => Navigator.pop(context, '')),
                for (final t in trips)
                  ChoiceRow(
                    title: t.dropoff.address ?? '—',
                    subtitle: '${dayAndTime(t.times.requestedAt, locale: context.localeTag)} · ${tripStatusLabel(l, t.status)}',
                    selected: selected == t.id,
                    onTap: () => Navigator.pop(context, t.id),
                  ),
              ],
            ),
            if (history.isLoading) const Padding(padding: EdgeInsets.only(top: 12), child: SkeletonList(rows: 2, avatar: false)),
            if (history.hasError) Padding(padding: const EdgeInsets.only(top: 12), child: Problem(history.error, describe: (e) => describeError(l, e))),
          ],
        ),
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
        appBar: AppBar(title: Text(l.support)),
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: async.hasError
              ? Problem(async.error, describe: (e) => describeError(l, e), onRetry: () => ref.invalidate(ticketThreadProvider(widget.ticketId)), retryLabel: l.retry)
              : const SkeletonList(rows: 4, avatar: false),
        ),
      );
    }
    final t = thread.ticket;
    final now = DateTime.now();
    return Scaffold(
      appBar: AppBar(title: Text('#${t.ref}')),
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
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
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
                    SectionCard(title: l.ticketAnswer, child: Text(t.resolutionNote!, style: AnbessaType.body2.copyWith(color: c.text))),
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
                    OutlinedButton(onPressed: _busy ? null : _reopen, child: Text(l.ticketReopen)),
                  ] else if (!t.canReply) ...[
                    Notice(l.ticketClosedLede),
                    const SizedBox(height: 8),
                    TextButton(onPressed: () => context.push(Routes.supportNew), child: Text(l.newTicket)),
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
