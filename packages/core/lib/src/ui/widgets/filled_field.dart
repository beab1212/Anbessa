// The GoRide text field: a bold label above a filled, borderless, radius-12 box with an optional
// leading icon; an amber border while focused. The phone variant puts a flag, a chevron and the
// dialling code before the number.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../theme/anbessa_theme.dart';
import '../theme/tokens.dart';

/// The bold label over a field ("Full Name", "Phone Number").
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(text, style: AnbessaType.body.copyWith(color: context.colors.text, fontWeight: FontWeight.w600)),
      );
}

class FilledField extends StatelessWidget {
  const FilledField({
    super.key,
    this.label,
    this.hint,
    this.controller,
    this.initialValue,
    this.icon,
    this.suffix,
    this.onChanged,
    this.onSubmitted,
    this.onTap,
    this.validator,
    this.keyboardType,
    this.textInputAction,
    this.inputFormatters,
    this.autofillHints,
    this.focusNode,
    this.obscureText = false,
    this.readOnly = false,
    this.enabled = true,
    this.autofocus = false,
    this.maxLines = 1,
    this.maxLength,
    this.textCapitalization = TextCapitalization.none,
    this.errorText,
    this.textAlign = TextAlign.start,
    this.style,
    this.prefix,
  }) : _phone = null;

  /// A phone number field: [flag] (an emoji or widget), a chevron and [dialCode] before the
  /// digits; [onCountryTap] opens a country picker.
  const FilledField.phone({
    super.key,
    this.label,
    this.hint,
    this.controller,
    this.initialValue,
    required String dialCode,
    Widget? flag,
    VoidCallback? onCountryTap,
    this.onChanged,
    this.onSubmitted,
    this.validator,
    this.focusNode,
    this.textInputAction,
    this.inputFormatters,
    this.enabled = true,
    this.autofocus = false,
    this.errorText,
    this.style,
  })  : _phone = (dialCode: dialCode, flag: flag, onTap: onCountryTap),
        icon = null,
        suffix = null,
        onTap = null,
        keyboardType = TextInputType.phone,
        autofillHints = const [AutofillHints.telephoneNumberNational],
        obscureText = false,
        readOnly = false,
        maxLines = 1,
        maxLength = null,
        textCapitalization = TextCapitalization.none,
        textAlign = TextAlign.start,
        prefix = null;

  final String? label;
  final String? hint;
  final TextEditingController? controller;
  final String? initialValue;
  /// the leading glyph (mail, location, search)
  final IconData? icon;
  /// a trailing widget (a chevron for a dropdown, a calendar, an eye)
  final Widget? suffix;
  /// a widget before the text (used by the phone variant)
  final Widget? prefix;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  /// for read-only pickers (gender, date of birth)
  final VoidCallback? onTap;
  final FormFieldValidator<String>? validator;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final List<TextInputFormatter>? inputFormatters;
  final Iterable<String>? autofillHints;
  final FocusNode? focusNode;
  final bool obscureText;
  final bool readOnly;
  final bool enabled;
  final bool autofocus;
  final int? maxLines;
  final int? maxLength;
  final TextCapitalization textCapitalization;
  final String? errorText;
  final TextAlign textAlign;
  final TextStyle? style;
  final ({String dialCode, Widget? flag, VoidCallback? onTap})? _phone;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final phone = _phone;
    Widget? prefixIcon;
    if (phone != null) {
      prefixIcon = _CountryPrefix(dialCode: phone.dialCode, flag: phone.flag, onTap: phone.onTap);
    } else if (prefix != null) {
      prefixIcon = prefix;
    } else if (icon != null) {
      prefixIcon = Padding(padding: const EdgeInsetsDirectional.only(start: 20, end: 12), child: Icon(icon, size: 20, color: c.text2));
    }
    final field = TextFormField(
      controller: controller,
      initialValue: controller == null ? initialValue : null,
      focusNode: focusNode,
      onChanged: onChanged,
      onFieldSubmitted: onSubmitted,
      onTap: onTap,
      validator: validator,
      keyboardType: keyboardType,
      textInputAction: textInputAction,
      inputFormatters: inputFormatters,
      autofillHints: autofillHints,
      obscureText: obscureText,
      readOnly: readOnly,
      enabled: enabled,
      autofocus: autofocus,
      maxLines: obscureText ? 1 : maxLines,
      maxLength: maxLength,
      textCapitalization: textCapitalization,
      textAlign: textAlign,
      cursorColor: c.accent,
      style: (style ?? AnbessaType.body).copyWith(color: enabled ? c.text : c.muted, fontWeight: FontWeight.w600),
      decoration: InputDecoration(
        hintText: hint,
        errorText: errorText,
        counterText: '',
        prefixIcon: prefixIcon,
        prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 24),
        suffixIcon: suffix == null ? null : Padding(padding: const EdgeInsetsDirectional.only(end: 12), child: suffix),
        suffixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 24),
        contentPadding: EdgeInsetsDirectional.fromSTEB(prefixIcon == null ? 20 : 0, 18, 20, 18),
      ),
    );
    if (label == null) return field;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [FieldLabel(label!), field],
    );
  }
}

class _CountryPrefix extends StatelessWidget {
  const _CountryPrefix({required this.dialCode, this.flag, this.onTap});
  final String dialCode;
  final Widget? flag;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final row = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (flag != null) ...[flag!, const SizedBox(width: 6)],
        if (onTap != null) ...[Icon(Icons.keyboard_arrow_down_rounded, size: 18, color: c.text2), const SizedBox(width: 6)],
        Text(dialCode, style: AnbessaType.body.copyWith(color: c.text, fontWeight: FontWeight.w600, fontFeatures: AnbessaType.tabular)),
        const SizedBox(width: 8),
      ],
    );
    return Padding(
      padding: const EdgeInsetsDirectional.only(start: 12),
      child: onTap == null
          ? Padding(padding: const EdgeInsetsDirectional.only(start: 8), child: row)
          : InkWell(
              onTap: onTap,
              borderRadius: BorderRadius.circular(AnbessaRadius.sm),
              child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8), child: row),
            ),
    );
  }
}
