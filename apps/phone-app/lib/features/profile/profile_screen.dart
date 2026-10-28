// Personal Info (the kit's p. 168): the photo with an edit badge, Full Name, the phone number
// (read only: it is how you sign in), Save pinned at the bottom. The photo is resized on the phone to 256 px and sent as a small JPEG data
// URL (the server refuses anything over 48 KB).

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:ride_app_core/ride_app_core.dart';
import '../../core/l10n/l10n.dart';
import '../../core/network/providers.dart';
import '../../core/session/session_controller.dart';
import 'account_hub_screen.dart' show meAvatarHeroTag;

class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});
  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  late final _name = TextEditingController(text: ref.read(currentSessionProvider)?.profile.name ?? '');
  bool _busy = false;
  bool _photoBusy = false;
  Object? _error;

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final p = await ref.read(authApiProvider).updateProfile(name: _name.text.trim());
      await ref.read(sessionProvider.notifier).updateProfile(p);
      Haptics.success();
      if (mounted) showToast(context, context.l10n.nameSaved, tone: NoticeTone.ok);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changePhoto() async {
    final l = context.l10n;
    final hasPhoto = ref.read(currentSessionProvider)?.profile.image != null;
    final choice = await showHandleSheet<String>(
      context,
      title: l.changePhoto,
      builder: (ctx) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListRowTile(icon: Icons.photo_camera_outlined, title: l.takePhotoOption, onTap: () => Navigator.pop(ctx, 'camera')),
          ListRowTile(icon: Icons.photo_library_outlined, title: l.chooseFromGalleryOption, onTap: () => Navigator.pop(ctx, 'gallery')),
          if (hasPhoto) ListRowTile(leading: CircleIcon(Icons.delete_outline_rounded, color: context.colors.danger), title: l.removePhoto, titleColor: context.colors.danger, onTap: () => Navigator.pop(ctx, 'remove')),
        ],
      ),
    );
    if (choice == null) return;
    setState(() {
      _photoBusy = true;
      _error = null;
    });
    try {
      String image = '';
      if (choice != 'remove') {
        final file = await ImagePicker().pickImage(source: choice == 'camera' ? ImageSource.camera : ImageSource.gallery, maxWidth: 256, maxHeight: 256, imageQuality: 70, requestFullMetadata: false);
        if (file == null) return;
        final bytes = await file.readAsBytes();
        image = 'data:image/jpeg;base64,${base64Encode(bytes)}';
        if (image.length > 48 * 1024) {
          // very dense photos: try harder
          final smaller = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 160, maxHeight: 160, imageQuality: 50, requestFullMetadata: false);
          if (smaller == null) return;
          image = 'data:image/jpeg;base64,${base64Encode(await smaller.readAsBytes())}';
        }
      }
      final p = await ref.read(authApiProvider).updateProfile(image: image);
      await ref.read(sessionProvider.notifier).updateProfile(p);
      Haptics.success();
      if (mounted) showToast(context, l.photoSaved, tone: NoticeTone.ok);
    } catch (e) {
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _photoBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = context.l10n;
    final c = context.colors;
    final s = ref.watch(currentSessionProvider);
    final phone = formatPhone(s?.profile.phone);
    final national = phone.startsWith('+251') ? phone.substring(4).trim() : phone;
    return Scaffold(
      appBar: AppTopBar(title: l.accPersonalInfo),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AnbessaSpace.page, 8, AnbessaSpace.page, 20),
              children: [
                Center(
                  child: Semantics(
                    button: true,
                    label: l.changePhoto,
                    child: GestureDetector(
                      onTap: _photoBusy ? null : _changePhoto,
                      child: SizedBox(
                        width: 104,
                        height: 104,
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            Hero(tag: meAvatarHeroTag, child: AvatarImage(src: s?.profile.image, name: s?.displayName ?? '', size: 104)),
                            if (_photoBusy) SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 2.5, color: c.text)),
                            // the kit's small edit badge on the photo's corner
                            PositionedDirectional(
                              end: 2,
                              bottom: 4,
                              child: Container(
                                width: 26,
                                height: 26,
                                decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(7), border: Border.all(color: c.page, width: 2)),
                                child: Icon(Icons.edit_rounded, size: 14, color: c.onAccent),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 28),
                FilledField(label: l.accFullName, hint: l.accFullName, controller: _name, textCapitalization: TextCapitalization.words, autofillHints: const [AutofillHints.name], onChanged: (_) => setState(() {})),
                const SizedBox(height: 24),
                FilledField.phone(
                  label: l.phoneLabel,
                  dialCode: '+251',
                  flag: const ExcludeSemantics(child: Text('🇪🇹', style: TextStyle(fontSize: 20))),
                  initialValue: national,
                  enabled: false,
                ),
                const SizedBox(height: 8),
                Text(l.accPhoneReadOnly, style: AnbessaType.caption.copyWith(color: c.muted)),
                const SizedBox(height: 16),
                Problem(_error, describe: (e) => describeError(l, e)),
              ],
            ),
          ),
          BottomActionBar(
            child: PillButton(label: l.save, busy: _busy, onPressed: _name.text.trim().length < 2 || _name.text.trim() == s?.profile.name ? null : _save),
          ),
        ],
      ),
    );
  }
}
