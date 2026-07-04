// Rider Radio — signaling server
// Serves the PWA (public/) and relays WebRTC signaling over Socket.IO.
// No accounts, no database. A "room" only exists as long as riders are in it.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // signaling only — no sensitive data crosses this
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Simple health check for Render
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// roomId -> Set of socket ids currently in that room
const rooms = new Map();

function ridersInRoom(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).size : 0;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let displayName = 'Rider';

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toLowerCase().slice(0, 40);
    if (!roomId) return;

    currentRoom = roomId;
    displayName = (name || 'Rider').toString().slice(0, 24);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const peers = rooms.get(roomId);

    // tell the newcomer who is already here
    const existingPeers = Array.from(peers).map((id) => ({
      id,
      name: io.sockets.sockets.get(id)?.data?.name || 'Rider'
    }));
    socket.data.name = displayName;

    peers.add(socket.id);
    socket.join(roomId);

    socket.emit('room-joined', { roomId, selfId: socket.id, peers: existingPeers });

    // existing peers will initiate the WebRTC offer toward the newcomer
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: displayName });
  });

  // Relay WebRTC signaling data (offers, answers, ICE candidates) peer-to-peer
  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom();
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers) {
      peers.delete(socket.id);
      if (peers.size === 0) rooms.delete(currentRoom);
    }
    socket.to(currentRoom).emit('peer-left', { id: socket.id });
    socket.leave(currentRoom);
    currentRoom = null;
  }
});

server.listen(PORT, () => {
  console.log(`Rider Radio signaling server listening on port ${PORT}`);
});
