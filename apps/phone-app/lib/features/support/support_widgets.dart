// Pieces shared by the help, ticket, lost-item and SOS screens: the words and tones for each
// status, one message of a thread, and the reply box.

import 'package:flutter/material.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';

String ticketCategoryLabel(AppLocalizations l, TicketCategory c) => switch (c) {
      TicketCategory.safety => l.ticketCategorySafety,
      TicketCategory.payment => l.ticketCategoryPayment,
      TicketCategory.trip => l.ticketCategoryTrip,
      TicketCategory.lostItem => l.ticketCategoryLostItem,
      TicketCategory.account => l.ticketCategoryAccount,
      TicketCategory.feedback => l.ticketCategoryFeedback,
      TicketCategory.unknown => '—',
    };

String ticketCategoryHint(AppLocalizations l, TicketCategory c) => switch (c) {
      TicketCategory.safety => l.ticketCategorySafetyHint,
      TicketCategory.payment => l.ticketCategoryPaymentHint,
      TicketCategory.trip => l.ticketCategoryTripHint,
      TicketCategory.account => l.ticketCategoryAccountHint,
      TicketCategory.feedback => l.ticketCategoryFeedbackHint,
      TicketCategory.lostItem || TicketCategory.unknown => '',
    };

String ticketStatusLabel(AppLocalizations l, TicketStatus s) => switch (s) {
      TicketStatus.open => l.ticketStatusOpen,
      TicketStatus.inProgress => l.ticketStatusInProgress,
      TicketStatus.waitingRequester => l.ticketStatusWaitingYou,
      TicketStatus.resolved => l.ticketStatusResolved,
      TicketStatus.closed => l.ticketStatusClosed,
      TicketStatus.unknown => '—',
    };

Tone ticketStatusTone(TicketStatus s) => switch (s) {
      TicketStatus.open => Tone.blue,
      TicketStatus.inProgress => Tone.blue,
      TicketStatus.waitingRequester => Tone.amber,
      TicketStatus.resolved => Tone.green,
      TicketStatus.closed || TicketStatus.unknown => Tone.grey,
    };

String lostItemStatusLabel(AppLocalizations l, LostItemStatus s) => switch (s) {
      LostItemStatus.reported => l.lostStatusReported,
      LostItemStatus.found => l.lostStatusFound,
      LostItemStatus.notFound => l.lostStatusNotFound,
      LostItemStatus.returned => l.lostStatusReturned,
      LostItemStatus.closed => l.lostStatusClosed,
      LostItemStatus.unknown => '—',
    };

Tone lostItemStatusTone(LostItemStatus s) => switch (s) {
      LostItemStatus.reported => Tone.amber,
      LostItemStatus.found => Tone.green,
      LostItemStatus.notFound => Tone.red,
      LostItemStatus.returned => Tone.green,
      LostItemStatus.closed || LostItemStatus.unknown => Tone.grey,
    };

/// What happens next, in words for whoever is looking.
String lostItemStatusLede(AppLocalizations l, LostItem item) => switch (item.status) {
      LostItemStatus.reported => item.isRider ? l.lostLedeReportedRider : l.lostLedeReportedDriver,
      LostItemStatus.found => item.isRider ? l.lostLedeFoundRider : l.lostLedeFoundDriver,
      LostItemStatus.notFound => item.isRider ? l.lostLedeNotFoundRider : l.lostLedeNotFoundDriver,
      LostItemStatus.returned => l.lostLedeReturned,
      LostItemStatus.closed || LostItemStatus.unknown => l.lostLedeClosed,
    };

String lostItemAuthorLabel(AppLocalizations l, LostItemRole author, LostItemRole viewer) {
  if (author == viewer) return l.threadYou;
  return switch (author) {
    LostItemRole.rider => l.riderLabel,
    LostItemRole.driver => l.driverLabel,
    LostItemRole.fleet => l.threadFleet,
    LostItemRole.staff || LostItemRole.unknown => l.threadSupport,
  };
}

/// One message: mine on the right, the other side on the left, system lines centred.
class ThreadMessage extends StatelessWidget {
  const ThreadMessage({super.key, required this.author, required this.body, required this.at, this.mine = false, this.system = false});
  final String author;
  final String body;
  final DateTime at;
  final bool mine;
  final bool system;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final when = dayAndTime(at, locale: context.localeTag);
    if (system) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 24),
        child: Text('$body · $when', textAlign: TextAlign.center, style: AnbessaType.caption.copyWith(color: c.muted)),
      );
    }
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: 0.86,
        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            color: mine ? c.surface2 : c.surface,
            border: Border.all(color: mine ? c.borderStrong : c.border),
            borderRadius: BorderRadius.circular(AnbessaRadius.md),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$author · $when', style: AnbessaType.label.copyWith(color: c.muted)),
              const SizedBox(height: 4),
              Text(body, style: AnbessaType.body2.copyWith(color: c.text)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The reply box at the bottom of a thread. [onSend] throws to show the error; the text is kept
/// until it succeeds.
class ReplyComposer extends StatefulWidget {
  const ReplyComposer({super.key, required this.onSend, this.maxLength = 2000});
  final Future<void> Function(String body) onSend;
  final int maxLength;
  @override
  State<ReplyComposer> createState() => _ReplyComposerState();
}

class _ReplyComposerState extends State<ReplyComposer> {
  final _text = TextEditingController();
  bool _busy = false;
  Object? _error;

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

  Future<void> _send() async {
    final body = _text.text.trim();
    if (body.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onSend(body);
      _text.clear();
      Haptics.light();
    } catch (e) {
      _error = e;
      Haptics.error();
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final canSend = _text.text.trim().isNotEmpty && !_busy;
    return DecoratedBox(
      decoration: BoxDecoration(color: c.canvas, border: Border(top: BorderSide(color: c.border))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8, right: 4), child: Problem(_error, describe: (e) => describeError(l, e))),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _text,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: widget.maxLength,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: InputDecoration(hintText: l.replyHint, counterText: '', isDense: true),
                    ),
                  ),
                  const SizedBox(width: 4),
                  IconButton(
                    tooltip: l.send,
                    onPressed: canSend ? _send : null,
                    icon: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.send_rounded),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
