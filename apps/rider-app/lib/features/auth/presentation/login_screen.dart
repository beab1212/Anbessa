import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:ride_app_core/widgets/primary_button.dart';

import '../../../core/session/session.dart';

class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // In a real build this calls auth_repository.dart and picks the role from
    // the JWT's `role` claim. Until auth is wired up, choose the mode directly.
    final session = ref.read(sessionRoleProvider.notifier);
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: 12,
          children: [
            Text('Login', style: Theme.of(context).textTheme.headlineMedium),
            PrimaryButton(label: 'Continue as rider', onPressed: () => session.signIn(AppRole.rider)),
            PrimaryButton(label: 'Continue as driver', onPressed: () => session.signIn(AppRole.driver)),
          ],
        ),
      ),
    );
  }
}
