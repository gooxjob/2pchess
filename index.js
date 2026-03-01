import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

/**
 * @typedef {'W1'|'W2'|'B1'|'B2'} PlayerSlot
 */

const SLOTS = /** @type {PlayerSlot[]} */ (['W1', 'W2', 'B1', 'B2']);

const rooms = new Map();

function getSlotTeam(slot) {
  return slot.startsWith('W') ? 'white' : 'black';
}

function getSlotZone(slot) {
  return slot === 'W1' || slot === 'B1' ? 'queenside' : 'kingside';
}

function makeEmptySlot(slot) {
  return {
    player_id: '',
    display_name: 'Waiting...',
    slot,
    team: getSlotTeam(slot),
    zone: getSlotZone(slot),
    is_ai: false,
    elo: 1200,
    connection_status: 'disconnected',
    device_type: 'desktop',
  };
}

function makeSlotPlayer(slot, name, socketId) {
  return {
    player_id: socketId,
    display_name: name,
    slot,
    team: getSlotTeam(slot),
    zone: getSlotZone(slot),
    is_ai: false,
    elo: 1200,
    connection_status: 'connected',
    device_type: 'desktop',
  };
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('create-room', ({ roomCode, playerName, slot }) => {
    if (rooms.has(roomCode)) {
      socket.emit('error', 'Room already exists');
      return;
    }

    /** @type {Record<PlayerSlot, any>} */
    const players = {};
    for (const s of SLOTS) {
      players[s] = makeEmptySlot(s);
    }
    const hostSlot = SLOTS.includes(slot) ? slot : 'W1';
    players[hostSlot] = makeSlotPlayer(hostSlot, playerName, socket.id);

    const room = {
      code: roomCode,
      hostId: socket.id,
      state: 'LOBBY',
      players,
      turnTime: 300,
      sockets: new Map([[socket.id, hostSlot]]),
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('room-joined', { slot: hostSlot, roomCode });
    io.to(roomCode).emit('room-update', { players: room.players, state: room.state, turnTime: room.turnTime });
    console.log(`Room ${roomCode} created by ${playerName} (${hostSlot})`);
  });

  socket.on('join-room', ({ roomCode, playerName, preferredSlot }) => {
    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    if (room.state !== 'LOBBY') {
      socket.emit('error', 'Game already in progress');
      return;
    }

    /** @type {PlayerSlot | null} */
    let assignedSlot = null;
    if (preferredSlot && room.players[preferredSlot]?.connection_status === 'disconnected') {
      assignedSlot = preferredSlot;
    } else {
      for (const s of SLOTS) {
        if (room.players[s].connection_status === 'disconnected') {
          assignedSlot = s;
          break;
        }
      }
    }

    if (!assignedSlot) {
      socket.emit('error', 'Room is full');
      return;
    }

    room.players[assignedSlot] = makeSlotPlayer(assignedSlot, playerName, socket.id);
    room.sockets.set(socket.id, assignedSlot);
    socket.join(roomCode);

    socket.emit('room-joined', { slot: assignedSlot, roomCode });
    io.to(roomCode).emit('room-update', { players: room.players, state: room.state, turnTime: room.turnTime });
    io.to(roomCode).emit('player-joined', { slot: assignedSlot, name: playerName });
    console.log(`${playerName} joined room ${roomCode} as ${assignedSlot}`);
  });

  socket.on('make-move', ({ roomCode, from, to, promotion, slot }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    socket.to(roomCode).emit('move-made', { from, to, promotion, slot });
  });

  socket.on('chat-message', ({ roomCode, message }) => {
    socket.to(roomCode).emit('chat-message', message);
  });

  socket.on('start-game', ({ roomCode, turnTime }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    room.state = 'IN_PROGRESS';
    if (turnTime) room.turnTime = turnTime;

    io.to(roomCode).emit('room-update', { players: room.players, state: room.state, turnTime: room.turnTime });
    socket.to(roomCode).emit('game-started', { turnTime: room.turnTime });
    console.log(`Game started in room ${roomCode} (${room.turnTime}s per player)`);
  });

  socket.on('time-change', ({ roomCode, turnTime }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;

    room.turnTime = turnTime;
    socket.to(roomCode).emit('time-changed', { turnTime });
  });

  socket.on('slot-config', ({ roomCode, slot, config }) => {
    const room = rooms.get(roomCode);
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (!room.players[slot]) return;

    Object.assign(room.players[slot], config);
    socket.to(roomCode).emit('slot-config', { slot, config });
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);

    for (const [code, room] of rooms) {
      if (room.sockets.has(socket.id)) {
        const slot = room.sockets.get(socket.id);
        const playerName = room.players[slot]?.display_name || 'Unknown';

        room.players[slot] = makeEmptySlot(slot);
        room.sockets.delete(socket.id);

        io.to(code).emit('player-left', { slot, name: playerName });
        io.to(code).emit('room-update', { players: room.players, state: room.state, turnTime: room.turnTime });

        if (room.sockets.size === 0) {
          rooms.delete(code);
          console.log(`Room ${code} removed (empty)`);
        }
        break;
      }
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`2v2 Chess server running on port ${PORT}`);
});

