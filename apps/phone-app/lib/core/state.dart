// A plain value holder for Riverpod 3 (StateProvider moved to the legacy library).

import 'package:flutter_riverpod/flutter_riverpod.dart';

class ValueState<T> extends Notifier<T> {
  ValueState(this._initial);
  final T _initial;
  @override
  T build() => _initial;
  void set(T v) => state = v;
}

NotifierProvider<ValueState<T>, T> valueProvider<T>(T initial) => NotifierProvider<ValueState<T>, T>(() => ValueState<T>(initial));
