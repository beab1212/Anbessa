// The GoRide top bar: a back arrow (or an X) on the left, a bold 20 pt title centred (or right
// after the icon, as on "Where do you want to go?"), optional actions on the right. No shadow,
// the page colour behind it.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

enum TopBarLeading {
  /// ← (pops the route)
  back,

  /// ✕ (closes a flow)
  close,

  /// nothing (a tab root: pass [AppTopBar.leading] for a logo)
  none,
}

class AppTopBar extends StatelessWidget implements PreferredSizeWidget {
  const AppTopBar({
    super.key,
    this.title,
    this.titleWidget,
    this.leadingKind = TopBarLeading.back,
    this.leading,
    this.onLeading,
    this.leadingTooltip,
    this.actions = const [],
    this.centerTitle = true,
    this.background,
    this.bottom,
  });

  final String? title;
  /// instead of [title]
  final Widget? titleWidget;
  final TopBarLeading leadingKind;
  /// replaces the back/close icon (a logo on tab roots)
  final Widget? leading;
  /// defaults to `Navigator.maybePop`
  final VoidCallback? onLeading;
  /// defaults to the Material "Back" / "Close" tooltip
  final String? leadingTooltip;
  /// icons on the right (IconButton, 24 pt glyphs: ⋮, +, phone, video)
  final List<Widget> actions;
  /// false: the title follows the leading icon ("✕  Where do you want to go?")
  final bool centerTitle;
  /// defaults to the page colour
  final Color? background;
  final PreferredSizeWidget? bottom;

  @override
  Size get preferredSize => Size.fromHeight(AnbessaSize.topBar + (bottom?.preferredSize.height ?? 0));

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ml = MaterialLocalizations.of(context);
    Widget? lead = leading;
    if (lead == null && leadingKind != TopBarLeading.none) {
      final close = leadingKind == TopBarLeading.close;
      lead = IconButton(
        icon: Icon(close ? Icons.close_rounded : Icons.arrow_back_rounded, size: 26),
        color: c.text,
        tooltip: leadingTooltip ?? (close ? ml.closeButtonTooltip : ml.backButtonTooltip),
        onPressed: onLeading ?? () => Navigator.maybePop(context),
      );
    }
    final t = titleWidget ??
        (title == null
            ? null
            : Text(title!, maxLines: 1, overflow: TextOverflow.ellipsis, style: AnbessaType.h2.copyWith(color: c.text)));
    return AppBar(
      backgroundColor: background ?? c.page,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      toolbarHeight: AnbessaSize.topBar,
      automaticallyImplyLeading: false,
      leading: lead == null ? null : Padding(padding: const EdgeInsetsDirectional.only(start: 8), child: Center(child: lead)),
      leadingWidth: lead == null ? 0 : 56,
      titleSpacing: lead == null ? AnbessaSpace.page : (centerTitle ? 0 : 4),
      centerTitle: centerTitle,
      title: t == null ? null : Semantics(header: true, child: t),
      actions: actions.isEmpty ? null : [...actions, const SizedBox(width: 8)],
      bottom: bottom,
    );
  }
}
