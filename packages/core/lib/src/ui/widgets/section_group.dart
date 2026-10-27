// Settings-style lists: a titled group of rows in one rounded card.

import 'package:flutter/material.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

class SectionGroup extends StatelessWidget {
  const SectionGroup({super.key, this.title, required this.children, this.margin = const EdgeInsets.only(bottom: 16)});
  final String? title;
  final List<Widget> children;
  final EdgeInsets margin;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: margin,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) Padding(padding: const EdgeInsets.fromLTRB(4, 0, 4, 8), child: Text(title!, style: AnbessaType.label.copyWith(color: c.muted, letterSpacing: 0.4))),
          Container(
            decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(AnbessaRadius.lg), border: Border.all(color: c.border)),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (final (i, w) in children.indexed) ...[
                  if (i > 0) Divider(indent: 56, color: c.border),
                  w,
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class SettingsTile extends StatelessWidget {
  const SettingsTile({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.destructive = false,
    this.iconTone,
    this.chevron = true,
    this.badge,
  });
  final IconData icon;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool destructive;
  final Color? iconTone;
  final bool chevron;
  /// a short pill after the title ("Coming soon", "3")
  final Widget? badge;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fg = destructive ? c.danger : c.text;
    final tone = iconTone ?? (destructive ? c.danger : c.accentStrong);
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: LayoutBuilder(builder: (context, box) => Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(color: tone.withValues(alpha: c.isDark ? 0.2 : 0.12), borderRadius: BorderRadius.circular(AnbessaRadius.sm)),
                child: Icon(icon, size: 19, color: tone),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(child: Text(title, style: AnbessaType.body.copyWith(color: fg, fontWeight: FontWeight.w500))),
                        if (badge != null) ...[const SizedBox(width: 8), badge!],
                      ],
                    ),
                    if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(subtitle!, style: AnbessaType.caption.copyWith(color: c.muted))),
                  ],
                ),
              ),
              // the trailing pill or value never takes more than about half the row
              if (trailing != null) ...[const SizedBox(width: 8), ConstrainedBox(constraints: BoxConstraints(maxWidth: box.maxWidth * 0.45), child: trailing!)],
              if (chevron && onTap != null && trailing == null) Icon(Icons.chevron_right_rounded, color: c.faint),
            ],
          )),
        ),
      ),
    );
  }
}

class SettingsSwitchTile extends StatelessWidget {
  const SettingsSwitchTile({super.key, required this.icon, required this.title, this.subtitle, required this.value, required this.onChanged});
  final IconData icon;
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;
  @override
  Widget build(BuildContext context) => SettingsTile(
        icon: icon,
        title: title,
        subtitle: subtitle,
        onTap: onChanged == null ? null : () => onChanged!(!value),
        chevron: false,
        trailing: Switch.adaptive(value: value, onChanged: onChanged),
      );
}

class SettingsValueTile extends StatelessWidget {
  const SettingsValueTile({super.key, required this.icon, required this.title, required this.value, this.onTap});
  final IconData icon;
  final String title;
  final String value;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SettingsTile(
      icon: icon,
      title: title,
      onTap: onTap,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value, style: AnbessaType.body2.copyWith(color: c.muted)),
          if (onTap != null) Icon(Icons.chevron_right_rounded, color: c.faint),
        ],
      ),
    );
  }
}

/// A row of choices where one is selected (language, theme, payment provider).
class ChoiceRow extends StatelessWidget {
  const ChoiceRow({super.key, required this.title, this.subtitle, required this.selected, required this.onTap, this.leading});
  final String title;
  final String? subtitle;
  final bool selected;
  final VoidCallback onTap;
  final Widget? leading;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        child: Row(
          children: [
            if (leading != null) ...[leading!, const SizedBox(width: 12)],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: AnbessaType.body.copyWith(fontWeight: FontWeight.w500)),
                  if (subtitle != null) Text(subtitle!, style: AnbessaType.caption.copyWith(color: c.muted)),
                ],
              ),
            ),
            AnimatedContainer(
              duration: AnbessaMotion.of(context, AnbessaMotion.base),
              width: 22,
              height: 22,
              decoration: BoxDecoration(shape: BoxShape.circle, color: selected ? c.primaryFill : Colors.transparent, border: Border.all(color: selected ? c.primaryFill : c.borderStrong, width: 2)),
              child: selected ? Icon(Icons.check, size: 14, color: c.onAccent) : null,
            ),
          ],
        ),
      ),
    );
  }
}
