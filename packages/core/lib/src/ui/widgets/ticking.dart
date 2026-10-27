// Small widgets that tick on their own: a countdown to a moment (quote expiry, offer window) and
// the time since a moment (finding a driver, waiting at the pickup). Only this widget rebuilds
// every second, never the screen around it. The timer pauses while the widget is in a muted
// TickerMode (an offstage tab or route) and stops once a countdown reaches zero.

import 'dart:async';

import 'package:flutter/widgets.dart';

/// Rebuilds [builder] every [interval] with the current time. The base of [Countdown] and
/// [ElapsedText]; use it directly when the ticking part is more than a text.
class TickingBuilder extends StatefulWidget {
  const TickingBuilder({super.key, required this.builder, this.interval = const Duration(seconds: 1), this.now = DateTime.now, this.stopWhen});
  final Widget Function(BuildContext context, DateTime now) builder;
  final Duration interval;
  /// the clock (tests pass their own)
  final DateTime Function() now;
  /// stop ticking once this is true for the current time (a countdown at zero)
  final bool Function(DateTime now)? stopWhen;

  @override
  State<TickingBuilder> createState() => _TickingBuilderState();
}

class _TickingBuilderState extends State<TickingBuilder> {
  Timer? _timer;
  bool _enabled = true;
  bool _stopped = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled = TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didUpdateWidget(TickingBuilder old) {
    super.didUpdateWidget(old);
    if (old.interval != widget.interval) {
      _timer?.cancel();
      _timer = null;
    }
    _stopped = false; // a new target may need ticking again
    _sync();
  }

  void _sync() {
    final want = _enabled && !_stopped && !(widget.stopWhen?.call(widget.now()) ?? false);
    if (!want) {
      _timer?.cancel();
      _timer = null;
    } else {
      _timer ??= Timer.periodic(widget.interval, (_) => _tick());
    }
  }

  void _tick() {
    if (!mounted) return;
    if (widget.stopWhen?.call(widget.now()) ?? false) {
      _stopped = true;
      _timer?.cancel();
      _timer = null;
    }
    setState(() {});
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, widget.now());
}

/// The time left until [until] as text, ticking once a second; never negative. [onDone] runs
/// once when it reaches zero (not when it starts at zero).
class Countdown extends StatefulWidget {
  const Countdown({super.key, required this.until, required this.format, this.style, this.onDone, this.now = DateTime.now, this.textAlign});
  final DateTime until;
  final String Function(Duration remaining) format;
  final TextStyle? style;
  final VoidCallback? onDone;
  final DateTime Function() now;
  final TextAlign? textAlign;

  @override
  State<Countdown> createState() => _CountdownState();
}

class _CountdownState extends State<Countdown> {
  late bool _done;

  @override
  void initState() {
    super.initState();
    _done = !widget.until.isAfter(widget.now()); // already over: no onDone
  }

  @override
  void didUpdateWidget(Countdown old) {
    super.didUpdateWidget(old);
    if (old.until != widget.until) _done = !widget.until.isAfter(widget.now());
  }

  @override
  Widget build(BuildContext context) => TickingBuilder(
        now: widget.now,
        stopWhen: (now) => !widget.until.isAfter(now),
        builder: (context, now) {
          final left = widget.until.difference(now);
          final remaining = left.isNegative ? Duration.zero : left;
          if (remaining == Duration.zero && !_done) {
            _done = true;
            final cb = widget.onDone;
            if (cb != null) WidgetsBinding.instance.addPostFrameCallback((_) => cb());
          }
          return Text(widget.format(remaining), style: widget.style, textAlign: widget.textAlign);
        },
      );
}

/// The time since [since] as text, ticking once a second ("Finding a driver · 0:42"; `mmss` formats it).
class ElapsedText extends StatelessWidget {
  const ElapsedText({super.key, required this.since, required this.format, this.style, this.now = DateTime.now, this.textAlign});
  final DateTime since;
  final String Function(Duration elapsed) format;
  final TextStyle? style;
  final DateTime Function() now;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) => TickingBuilder(
        now: now,
        builder: (context, t) {
          final d = t.difference(since);
          return Text(format(d.isNegative ? Duration.zero : d), style: style, textAlign: textAlign);
        },
      );
}
