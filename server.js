/**
 * Custom Next.js server + Socket.IO.
 * Next handles the UI/HTTP; Socket.IO (same port) handles real-time chat.
 * A single socket can be joined to MANY rooms at once (WhatsApp-style chat list),
 * so every real-time event is tagged with its room `code`.
 * Room/message state is persisted to data.json so chats survive restarts.
 */
const { createServer } = require('http');
const { parse } = require('url');
const path = require('path');
const fs = require('fs');
const next = require('next');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');

const makeCode = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 6); // no ambiguous chars
const makeId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

// ---------- Persistence ----------
let db = { rooms: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('Could not read data.json, starting fresh:', e.message);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => err && console.error('save error', err.message));
  }, 200);
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
    save();
  }
  return db.rooms[code];
}

// ---------- Next ----------
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
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
    save();
    io.to(code).emit('message', m);
  }

  io.on('connection', (socket) => {
    // Create a room
    socket.on('createRoom', ({ name, profile }, ack) => {
      let code = makeCode();
      while (db.rooms[code]) code = makeCode();
      const room = ensureRoom(code, (name || '').trim().slice(0, 60) || 'New Room', profile?.userId || null);
      ack && ack({ ok: true, code: room.code, name: room.name, ownerId: room.ownerId });
    });

    // Join a room (may be called several times — one socket can hold many rooms)
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
      save();

      ack && ack({
        ok: true,
        room: { code: room.code, name: room.name, ownerId: room.ownerId },
        messages: room.messages,
        members: presenceList(code),
      });
      if (isNew) sysMessage(code, `${profile.name || 'Someone'} joined`);
      emitPresence(code);
    });

    // New message (text / image / voice / file) — must carry its room `code`
    socket.on('message', (msg, ack) => {
      const sess = online.get(socket.id);
      if (!sess) return;
      const code = String(msg.code || '').toUpperCase();
      if (!sess.codes.has(code)) return; // not joined to that room
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
        media: msg.media || null, // { url, mime, name, size, duration }
        replyTo: msg.replyTo || null,
        ts: Date.now(),
        deleted: false,
      };
      room.messages.push(message);
      if (room.messages.length > 5000) room.messages.shift();
      save();
      io.to(code).emit('message', message);
      ack && ack({ ok: true, id: message.id, ts: message.ts });
    });

    socket.on('typing', ({ code, isTyping }) => {
      const sess = online.get(socket.id);
      if (!sess || !sess.codes.has(code)) return;
      socket.to(code).emit('typing', { code, userId: sess.userId, name: sess.name, isTyping: !!isTyping });
    });

    // Delete one message for everyone (author or owner)
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
      save();
      io.to(code).emit('messageDeleted', { code, id });
    });

    // Clear the entire chat for everyone (owner only, or anyone if no owner set)
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
      save();
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
        emitPresence(code);
      }
      save();
    });

    // Leave a single room (remove from this user's chat list)
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
        if (room && room.members[sess.userId]) room.members[sess.userId].lastSeen = Date.now();
        emitPresence(code);
      }
      online.delete(socket.id);
      save();
    });
  });

  server.listen(port, () => {
    console.log(`\n  ▶ ChatRoom ready on http://localhost:${port}\n`);
  });
});
