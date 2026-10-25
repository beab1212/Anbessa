import 'package:socket_io_client/socket_io_client.dart' as io;

/// Driver-mode counterpart to realtime-gateway's location.handler.ts —
/// samples GPS every ~4s and emits 'location:update' over the open socket.
class LocationPinger {
  LocationPinger(this._socket);
  final io.Socket _socket;

  void send(String tripId, double lat, double lng, {double? heading}) {
    _socket.emit('location:update', {'tripId': tripId, 'lat': lat, 'lng': lng, 'heading': heading});
  }
}
