import 'package:flutter/material.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    // Wires into auth_repository.dart via a Riverpod provider in a real build.
    return const Scaffold(body: Center(child: Text('Login')));
  }
}
