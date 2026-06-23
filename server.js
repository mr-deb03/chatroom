/**
 * Custom Next.js server + Socket.IO.
 * Next handles the UI/HTTP; Socket.IO (same port) handles real-time chat.
 * A single socket can be joined to MANY rooms at once (WhatsApp-style chat list),
 * so every real-time event is tagged with its room `code`.
 *
 * Persistence:
 *   - If MONGODB_URI is set, rooms/messages live in MongoDB (durable across restarts).
 *   - Otherwise they fall back to data.json on the local disk (fine for local dev).
 */
const { createServer } = require('http');
const { parse } = require('url');
const path = require('path');
const fs = require('fs');
const next = require('next');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');
const { MongoClient } = require('mongodb');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB = process.env.MONGODB_DB || 'chatroom';
let useMongo = !!MONGO_URI;

const makeCode = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6); // no ambiguous chars
const makeId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

// ---------- Persistence ----------
let db = { rooms: {} };
let roomsCol = null;

async function loadDb() {
  if (useMongo) {
    try {
      const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
      await client.connect();
      await client.db(MONGO_DB).command({ ping: 1 }); // verify the connection really works
      roomsCol = client.db(MONGO_DB).collection('rooms');
      const docs = await roomsCol.find({}).toArray();
      db.rooms = {};
      for (const d of docs) {
        const { _id, ...rest } = d;
        db.rooms[_id] = { code: _id, ...rest };
      }
      console.log(`  Storage: MongoDB (${docs.length} rooms loaded)`);
      return;
    } catch (e) {
      console.error('  ✖ MongoDB connection FAILED:', e.message);
      console.error('    → Check MONGODB_URI, and that Atlas Network Access allows 0.0.0.0/0.');
      console.error('    → Continuing with local file storage (NOT durable across restarts).');
      useMongo = false;
      roomsCol = null;
    }
  }
  try {
    if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not read data.json, starting fresh:', e.message);
  }
  console.log('  Storage: local data.json (set MONGODB_URI for durable storage)');
}

// Debounced, per-room persistence. We always know which room changed.
const dirtyRooms = new Set();
let flushTimer = null;
function markDirty(code) {
  if (!code) return;
  dirtyRooms.add(code);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 250);
}
async function flush() {
  const codes = [...dirtyRooms];
  dirtyRooms.clear();
  if (useMongo) {
    try {
      await Promise.all(codes.map((code) => {
        const room = db.rooms[code];
        if (!room) return roomsCol.deleteOne({ _id: code });
        const { code: _ignore, ...rest } = room;
        return roomsCol.replaceOne({ _id: code }, { _id: code, ...rest }, { upsert: true });
      }));
    } catch (e) {
      console.error('Mongo flush error:', e.message);
    }
  } else {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => err && console.error('save error', err.message));
  }
}

const getRoom = (code) => db.rooms[code];
function ensureRoom(code, name, ownerId) {
  if (!db.rooms[code]) {
    db.rooms[code] = {
      code,
      name: name || 'New Room',
      ownerId: ownerId || null,
      createdAt: Date.now(),
      messages: [],
      members: {}, // userId -> { name, avatar, lastSeen }
    };
    markDirty(code);
  }
  return db.rooms[code];
}

// ---------- Next ----------
const app = next({ dev });
const handle = app.getRequestHandler();

(async () => {
  await loadDb();
  await app.prepare();

  const server = createServer((req, res) => handle(req, res, parse(req.url, true)));
  const io = new Server(server, { maxHttpBufferSize: 1e8, cors: { origin: '*' } });

  const online = new Map(); // socket.id -> { userId, name, codes: Set<string> }

  function presenceList(code) {
    const room = getRoom(code);
    if (!room) return [];
    const onlineIds = new Set();
    for (const v of online.values()) if (v.codes.has(code)) onlineIds.add(v.userId);
    return Object.entries(room.members).map(([userId, m]) => ({
      userId,
      name: m.name,
      avatar: m.avatar || '',
      online: onlineIds.has(userId),
      lastSeen: m.lastSeen || 0,
    }));
  }
  const emitPresence = (code) => io.to(code).emit('presence', { code, members: presenceList(code) });

  function sysMessage(code, text) {
    const room = getRoom(code);
    if (!room) return;
    const m = { id: makeId(), code, type: 'system', text, ts: Date.now() };
    room.messages.push(m);
    markDirty(code);
    io.to(code).emit('message', m);
  }

  io.on('connection', (socket) => {
    socket.on('createRoom', ({ name, profile }, ack) => {
      let code = makeCode();
      while (db.rooms[code]) code = makeCode();
      const room = ensureRoom(code, (name || '').trim().slice(0, 60) || 'New Room', profile?.userId || null);
      ack && ack({ ok: true, code: room.code, name: room.name, ownerId: room.ownerId });
    });

    socket.on('join', ({ code, profile }, ack) => {
      code = String(code || '').toUpperCase().trim();
      if (!profile || !profile.userId) {
        ack && ack({ ok: false, error: 'Invalid profile.' });
        return;
      }
      const room = getRoom(code);
      if (!room) {
        ack && ack({ ok: false, error: 'Room not found. Check the code and try again.' });
        return;
      }
      let sess = online.get(socket.id);
      if (!sess) {
        sess = { userId: profile.userId, name: profile.name || 'Anonymous', codes: new Set() };
        online.set(socket.id, sess);
      }
      sess.userId = profile.userId;
      sess.name = profile.name || sess.name;

      const isNew = !room.members[sess.userId];
      room.members[sess.userId] = {
        name: profile.name || 'Anonymous',
        avatar: profile.avatar || '',
        lastSeen: Date.now(),
      };
      sess.codes.add(code);
      socket.join(code);
      markDirty(code);

      ack && ack({
        ok: true,
        room: { code: room.code, name: room.name, ownerId: room.ownerId },
        messages: room.messages,
        members: presenceList(code),
      });
      if (isNew) sysMessage(code, `${profile.name || 'Someone'} joined`);
      emitPresence(code);
    });

    socket.on('message', (msg, ack) => {
      const sess = online.get(socket.id);
      if (!sess) return;
      const code = String(msg.code || '').toUpperCase();
      if (!sess.codes.has(code)) return;
      const room = getRoom(code);
      if (!room) return;
      const message = {
        id: makeId(),
        code,
        userId: sess.userId,
        name: msg.name || sess.name || 'Anonymous',
        avatar: msg.avatar || '',
        type: ['text', 'image', 'voice', 'file'].includes(msg.type) ? msg.type : 'text',
        text: typeof msg.text === 'string' ? msg.text.slice(0, 5000) : '',
        media: msg.media || null,
        replyTo: msg.replyTo || null,
        ts: Date.now(),
        deleted: false,
      };
      room.messages.push(message);
      if (room.messages.length > 5000) room.messages.shift();
      markDirty(code);
      io.to(code).emit('message', message);
      ack && ack({ ok: true, id: message.id, ts: message.ts });
    });

    socket.on('typing', ({ code, isTyping }) => {
      const sess = online.get(socket.id);
      if (!sess || !sess.codes.has(code)) return;
      socket.to(code).emit('typing', { code, userId: sess.userId, name: sess.name, isTyping: !!isTyping });
    });

    socket.on('deleteMessage', ({ code, id }) => {
      const sess = online.get(socket.id);
      if (!sess || !sess.codes.has(code)) return;
      const room = getRoom(code);
      if (!room) return;
      const m = room.messages.find((x) => x.id === id);
      if (!m) return;
      if (m.userId !== sess.userId && room.ownerId !== sess.userId) return;
      m.deleted = true;
      m.text = '';
      m.media = null;
      markDirty(code);
      io.to(code).emit('messageDeleted', { code, id });
    });

    socket.on('clearChat', ({ code }, ack) => {
      const sess = online.get(socket.id);
      if (!sess || !sess.codes.has(code)) return;
      const room = getRoom(code);
      if (!room) return;
      if (room.ownerId && room.ownerId !== sess.userId) {
        ack && ack({ ok: false, error: 'Only the room creator can delete the chat for everyone.' });
        return;
      }
      room.messages = [];
      markDirty(code);
      io.to(code).emit('chatCleared', { code });
      ack && ack({ ok: true });
    });

    socket.on('updateProfile', ({ profile }) => {
      const sess = online.get(socket.id);
      if (!sess) return;
      sess.name = profile.name || sess.name;
      for (const code of sess.codes) {
        const room = getRoom(code);
        if (!room || !room.members[sess.userId]) continue;
        room.members[sess.userId].name = profile.name || room.members[sess.userId].name;
        room.members[sess.userId].avatar = profile.avatar ?? room.members[sess.userId].avatar;
        markDirty(code);
        emitPresence(code);
      }
    });

    socket.on('leave', ({ code }) => {
      const sess = online.get(socket.id);
      if (!sess) return;
      sess.codes.delete(code);
      socket.leave(code);
      emitPresence(code);
    });

    socket.on('disconnect', () => {
      const sess = online.get(socket.id);
      if (!sess) return;
      for (const code of sess.codes) {
        const room = getRoom(code);
        if (room && room.members[sess.userId]) {
          room.members[sess.userId].lastSeen = Date.now();
          markDirty(code);
        }
        emitPresence(code);
      }
      online.delete(socket.id);
    });
  });

  // Best-effort flush on shutdown (Render sends SIGTERM on restart/deploy)
  const shutdown = async () => { try { await flush(); } catch {} process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(port, () => {
    console.log(`\n  ▶ ChatRoom ready on http://localhost:${port}`);
  });
})();
