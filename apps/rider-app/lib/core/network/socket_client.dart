import 'package:socket_io_client/socket_io_client.dart' as io;

/// Wraps the connection to realtime-gateway. Token is passed once at
/// handshake (see auth.middleware.ts on the gateway side), not per message.
class SocketClient {
  SocketClient(String url, String accessToken) {
    socket = io.io(url, io.OptionBuilder().setTransports(['websocket']).setAuth({'token': accessToken}).build());
  }

  late final io.Socket socket;

  void subscribeToTrip(String tripId) => socket.emit('trip:subscribe', tripId);
}
