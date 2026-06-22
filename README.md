# 💬 ChatRoom

A real-time chat app built with **Next.js + Socket.IO** — WhatsApp-style. Talk to anyone
just by sharing an **invite/room code**.

## Features

- **Join by code** — create a room, get a 6-character code, share it. Anyone with the code joins.
- **Profile settings** — name, about, and avatar photo (editable any time).
- **Text messages** with reply/quote, day separators, timestamps and typing indicators.
- **Send images** — pick a photo, tap to view full-screen.
- **Voice notes** — hold-free record / send, with an inline player + seek bar.
- **Clear chat (only me)** — hides history on your device.
- **Delete message** — for me, or for everyone (your own messages / room admin).
- **Delete chat for everyone** — room creator wipes the whole conversation.
- **Online presence & last seen**, member list, recent rooms, deep links (`?room=CODE`).
- Messages persist across restarts (stored in `data.json`).

## Run it

```bash
npm install      # already done
npm run dev      # starts on http://localhost:3000
```

Open **http://localhost:3000**. To test a real conversation, open a second browser
(or an incognito window) and join with the same code.

### Production

```bash
npm run build
npm start        # NODE_ENV=production on port 3000 (set PORT to change)
```

## Talking to people on other devices

- **Same Wi‑Fi:** find your PC's IP (`ipconfig`) and others open `http://YOUR_IP:3000`.
  > Note: microphone (voice notes) and camera need a *secure context* — they work on
  > `localhost`, but on a plain `http://192.168.x.x` address browsers block them. For voice
  > notes over the network, put it behind HTTPS (e.g. a tunnel like `ngrok http 3000`).
- **Over the internet:** deploy to any Node host, or expose your local server with a tunnel.

## How it works

| File | Role |
|------|------|
| `server.js` | Custom server: runs Next.js **and** Socket.IO on one port; rooms, messages, presence, persistence |
| `app/api/upload/route.js` | Handles image / voice uploads → saved to `public/uploads` |
| `app/page.js` | The whole client app (profile, lobby, chat) |
| `app/components/` | `Avatar`, `VoiceNote` (player) |
| `app/lib/util.js` | Helpers (time formatting, uploads, image compression) |
| `data.json` | Persisted rooms & messages (auto-created) |
