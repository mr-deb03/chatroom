'use client';

import { useEffect, useRef, useState, useCallback, Fragment } from 'react';
import Avatar from './components/Avatar';
import VoiceNote from './components/VoiceNote';
import {
  uid, formatTime, dayKey, dayLabel, fmtDuration, lastSeenLabel, shortStamp,
  store, uploadFile, fileToCompressedDataURL, downloadMedia,
} from './lib/util';

export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [screen, setScreen] = useState('profile'); // profile | home
  const [profile, setProfile] = useState({ userId: '', name: '', about: '', avatar: '' });

  // chats: { [code]: { info, messages, members, unread, clearedAt, hidden:Set, lastTs } }
  const [chats, setChats] = useState({});
  const [activeCode, setActiveCode] = useState(null);
  const [typingByRoom, setTypingByRoom] = useState({}); // { code: { userId: name } }

  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);     // conversation overflow menu
  const [sideMenuOpen, setSideMenuOpen] = useState(false); // sidebar overflow menu
  const [itemMenu, setItemMenu] = useState(null);      // code whose list-item menu is open
  const [modal, setModal] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const [reactingId, setReactingId] = useState(null); // message id whose reaction picker is open
  const [theme, setTheme] = useState('dark');

  // PWA install
  const [installEvt, setInstallEvt] = useState(null); // deferred beforeinstallprompt event (Android/desktop)
  const [iosCapable, setIosCapable] = useState(false); // iOS Safari, not yet installed
  const [bannerOpen, setBannerOpen] = useState(false); // install banner visibility

  // new-chat modal fields
  const [tab, setTab] = useState('join');
  const [joinCode, setJoinCode] = useState('');
  const [createName, setCreateName] = useState('');
  const [joinError, setJoinError] = useState('');

  // recording
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  const socketRef = useRef(null);
  const profileRef = useRef(profile);
  const activeCodeRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimeoutsRef = useRef({});
  const selfTypingRef = useRef(null);
  const mediaRef = useRef({ recorder: null, chunks: [], stream: null, timer: null, send: false, startTime: 0 });

  const toast = useCallback((m) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(''), 2200);
  }, []);

  // ---------- recent rooms persistence ----------
  const rememberRoom = useCallback((info) => {
    const list = store.get('recentRooms', []).filter((x) => x.code !== info.code);
    list.unshift({ code: info.code, name: info.name, ts: Date.now() });
    store.set('recentRooms', list.slice(0, 30));
  }, []);
  const forgetRoom = useCallback((code) => {
    store.set('recentRooms', store.get('recentRooms', []).filter((x) => x.code !== code));
  }, []);

  const upsertChat = useCallback((res) => {
    const code = res.room.code;
    setChats((prev) => {
      const existing = prev[code];
      const msgs = res.messages || [];
      return {
        ...prev,
        [code]: {
          info: res.room,
          messages: msgs,
          members: res.members || existing?.members || [],
          unread: existing?.unread || 0,
          clearedAt: store.get(`cleared:${code}`, 0),
          hidden: new Set(store.get(`hidden:${code}`, [])),
          lastTs: msgs.length ? msgs[msgs.length - 1].ts : (existing?.lastTs || Date.now()),
        },
      };
    });
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    setMounted(true);
    let p = store.get('profile', null);
    if (!p || !p.userId) p = { userId: uid(), name: '', about: '', avatar: '' };
    setProfile(p);
    profileRef.current = p;
    if (p.name) setScreen('home');

    const savedTheme = store.get('theme', 'dark');
    setTheme(savedTheme);
    applyTheme(savedTheme);

    // Register the service worker so the app is installable on mobile
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const params = new URLSearchParams(window.location.search);
    const deepRoom = (params.get('room') || '').toUpperCase();

    let cancelled = false;
    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const socket = io({ transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('message', (m) => {
        setChats((prev) => {
          const c = prev[m.code];
          if (!c || c.messages.some((x) => x.id === m.id)) return prev;
          const mine = m.userId === profileRef.current.userId;
          const active = activeCodeRef.current === m.code &&
            (typeof document === 'undefined' || document.visibilityState === 'visible');
          const unread = mine || active || m.type === 'system' ? c.unread : c.unread + 1;
          return { ...prev, [m.code]: { ...c, messages: [...c.messages, m], lastTs: m.ts, unread } };
        });
      });
      socket.on('messageDeleted', ({ code, id }) => {
        setChats((prev) => {
          const c = prev[code];
          if (!c) return prev;
          return { ...prev, [code]: { ...c, messages: c.messages.map((m) => m.id === id ? { ...m, deleted: true, text: '', media: null } : m) } };
        });
      });
      socket.on('chatCleared', ({ code }) => {
        setChats((prev) => (prev[code] ? { ...prev, [code]: { ...prev[code], messages: [] } } : prev));
      });
      socket.on('reaction', ({ code, id, reactions }) => {
        setChats((prev) => {
          const c = prev[code];
          if (!c) return prev;
          return { ...prev, [code]: { ...c, messages: c.messages.map((m) => m.id === id ? { ...m, reactions } : m) } };
        });
      });
      socket.on('presence', ({ code, members }) => {
        setChats((prev) => (prev[code] ? { ...prev, [code]: { ...prev[code], members } } : prev));
      });
      socket.on('roomUpdated', ({ code, room }) => {
        setChats((prev) => (prev[code] ? { ...prev, [code]: { ...prev[code], info: room } } : prev));
      });
      socket.on('typing', ({ code, userId, name, isTyping }) => {
        setTypingByRoom((prev) => {
          const room = { ...(prev[code] || {}) };
          if (isTyping) room[userId] = name; else delete room[userId];
          return { ...prev, [code]: room };
        });
        const key = `${code}:${userId}`;
        clearTimeout(typingTimeoutsRef.current[key]);
        if (isTyping) {
          typingTimeoutsRef.current[key] = setTimeout(() => {
            setTypingByRoom((prev) => {
              const room = { ...(prev[code] || {}) };
              delete room[userId];
              return { ...prev, [code]: room };
            });
          }, 4000);
        }
      });

      // rejoin every known room so the chat list is live.
      // Use the local `p` (not profileRef) — the ref can be transiently reset to the
      // initial empty profile by the [profile] effect before this async callback runs.
      const rec = store.get('recentRooms', []);
      rec.forEach((r) => socket.emit('join', { code: r.code, profile: p }, (res) => {
        if (res?.ok) { upsertChat(res); return; }
        // Server couldn't return the room (offline / restarted). Keep it in the list
        // as a placeholder rather than silently deleting it — chats stay until the
        // user explicitly removes them. It refills automatically once the server has it.
        setChats((prev) => prev[r.code] ? prev : {
          ...prev,
          [r.code]: {
            info: { code: r.code, name: r.name || r.code, ownerId: null },
            messages: [], members: [], unread: 0,
            clearedAt: store.get(`cleared:${r.code}`, 0),
            hidden: new Set(store.get(`hidden:${r.code}`, [])),
            lastTs: r.ts || 0, unavailable: true,
          },
        });
      }));

      if (deepRoom) {
        socket.emit('join', { code: deepRoom, profile: p }, (res) => {
          if (res?.ok) { upsertChat(res); rememberRoom(res.room); setActiveCode(res.room.code); activeCodeRef.current = res.room.code; }
        });
      }
    });

    return () => { cancelled = true; socketRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { activeCodeRef.current = activeCode; }, [activeCode]);

  // ---------- PWA install prompt ----------
  useEffect(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) return; // already installed — nothing to prompt

    const dismissed = store.get('installDismissed', false);

    const onBIP = (e) => {
      e.preventDefault();
      setInstallEvt(e);
      if (!dismissed) setBannerOpen(true);
    };
    window.addEventListener('beforeinstallprompt', onBIP);

    const onInstalled = () => {
      setBannerOpen(false); setInstallEvt(null); setIosCapable(false);
      store.set('installDismissed', true);
      toast('ChatRoom installed 🎉');
    };
    window.addEventListener('appinstalled', onInstalled);

    // iOS Safari never fires beforeinstallprompt — show manual instructions instead.
    const ua = window.navigator.userAgent || '';
    const isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && 'ontouchend' in document);
    const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|android/i.test(ua);
    if (isIOS && isSafari) { setIosCapable(true); if (!dismissed) setBannerOpen(true); }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [toast]);

  const canInstall = !!installEvt || iosCapable;

  async function doInstall() {
    if (!installEvt) return; // iOS path shows manual instructions in the banner
    installEvt.prompt();
    try { await installEvt.userChoice; } catch {}
    setInstallEvt(null); setBannerOpen(false);
  }
  function dismissInstall() {
    setBannerOpen(false);
    store.set('installDismissed', true);
  }
  function openInstall() {
    setSideMenuOpen(false); setMenuOpen(false);
    if (installEvt) doInstall();
    else setBannerOpen(true); // iOS: reveal the "Add to Home Screen" steps
  }

  const activeChat = activeCode ? chats[activeCode] : null;
  const activeMsgCount = activeChat ? activeChat.messages.length : 0;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeCode, activeMsgCount, typingByRoom]);

  useEffect(() => {
    if (!menuOpen && !sideMenuOpen && itemMenu === null && reactingId === null) return;
    const h = () => { setMenuOpen(false); setSideMenuOpen(false); setItemMenu(null); setReactingId(null); };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [menuOpen, sideMenuOpen, itemMenu, reactingId]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  // ---------- profile ----------
  function saveProfileBasics() {
    const name = profile.name.trim();
    if (!name) return toast('Please enter your name');
    const p = { ...profile, name };
    store.set('profile', p);
    setProfile(p);
    setScreen('home');
  }
  async function pickAvatar(file) {
    if (!file) return;
    try {
      const dataUrl = await fileToCompressedDataURL(file, 256);
      setProfile((p) => ({ ...p, avatar: dataUrl }));
    } catch { toast('Could not load that image'); }
  }
  function saveProfileSettings(updated) {
    const p = { ...profile, ...updated, name: (updated.name ?? profile.name).trim() || profile.name };
    store.set('profile', p);
    setProfile(p);
    socketRef.current?.emit('updateProfile', { profile: p });
    setModal(null);
    toast('Profile updated');
  }

  // ---------- join / create / open / leave ----------
  function openChat(code) {
    setActiveCode(code);
    activeCodeRef.current = code;
    setText(''); setReplyTo(null);
    setChats((prev) => (prev[code] ? { ...prev, [code]: { ...prev[code], unread: 0 } } : prev));
  }
  function doJoin(code) {
    setJoinError('');
    const c = (code || joinCode).toUpperCase().trim();
    if (c.length < 4) return setJoinError('Enter a valid room code');
    socketRef.current.emit('join', { code: c, profile }, (res) => {
      if (!res?.ok) return setJoinError(res?.error || 'Could not join');
      upsertChat(res); rememberRoom(res.room);
      setModal(null); setJoinCode('');
      openChat(res.room.code);
    });
  }
  function doCreate() {
    const name = createName.trim() || `${profile.name}'s room`;
    socketRef.current.emit('createRoom', { name, profile }, (res) => {
      if (!res?.ok) return toast('Could not create room');
      socketRef.current.emit('join', { code: res.code, profile }, (jr) => {
        if (!jr?.ok) return toast(jr?.error || 'Could not open room');
        upsertChat(jr); rememberRoom(jr.room);
        setCreateName('');
        openChat(jr.room.code);
        setModal({ type: 'invite', code: res.code });
      });
    });
  }
  function leaveChat(code) {
    socketRef.current?.emit('leave', { code });
    forgetRoom(code);
    setChats((prev) => { const n = { ...prev }; delete n[code]; return n; });
    if (activeCodeRef.current === code) { setActiveCode(null); activeCodeRef.current = null; }
    setModal(null); setMenuOpen(false); setItemMenu(null);
  }

  // ---------- sending ----------
  function emitTyping(isTyping) {
    if (activeCode) socketRef.current?.emit('typing', { code: activeCode, isTyping });
  }
  function onTextChange(v) {
    setText(v);
    emitTyping(true);
    clearTimeout(selfTypingRef.current);
    selfTypingRef.current = setTimeout(() => emitTyping(false), 1500);
  }
  function buildReplyMeta() {
    if (!replyTo) return null;
    return {
      id: replyTo.id, name: replyTo.name,
      preview: replyTo.type === 'image' ? '📷 Photo' : replyTo.type === 'voice' ? '🎙️ Voice message' : (replyTo.text || ''),
    };
  }
  function sendText() {
    const t = text.trim();
    if (!t || !activeCode) return;
    socketRef.current.emit('message', { code: activeCode, type: 'text', text: t, name: profile.name, avatar: profile.avatar, replyTo: buildReplyMeta() });
    setText(''); setReplyTo(null); emitTyping(false); clearTimeout(selfTypingRef.current);
  }
  async function sendImage(file) {
    if (!file || !activeCode) return;
    try {
      toast('Uploading…');
      const media = await uploadFile(file);
      socketRef.current.emit('message', { code: activeCode, type: 'image', media, text: text.trim(), name: profile.name, avatar: profile.avatar, replyTo: buildReplyMeta() });
      setText(''); setReplyTo(null);
    } catch (e) { toast(e.message || 'Upload failed'); }
  }

  // ---------- voice ----------
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Recording not supported here');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRef.current.chunks = [];
      mediaRef.current.send = false;
      mediaRef.current.stream = stream;
      mediaRef.current.recorder = recorder;
      mediaRef.current.startTime = Date.now();
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) mediaRef.current.chunks.push(e.data); };
      recorder.onstop = onRecordingStop;
      recorder.start();
      setRecSeconds(0); setRecording(true);
    } catch { toast('Microphone blocked. Use http://localhost or HTTPS and allow access.'); }
  }
  async function onRecordingStop() {
    const { chunks, stream, recorder, send, startTime } = mediaRef.current;
    stream?.getTracks().forEach((t) => t.stop());
    const duration = Math.max(1, Math.round((Date.now() - (startTime || Date.now())) / 1000));
    setRecording(false);
    if (!send || !chunks.length || !activeCodeRef.current) return;
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      toast('Sending voice note…');
      const media = await uploadFile(blob, `voice-${Date.now()}.webm`);
      media.duration = duration;
      socketRef.current.emit('message', { code: activeCodeRef.current, type: 'voice', media, name: profile.name, avatar: profile.avatar, replyTo: buildReplyMeta() });
      setReplyTo(null);
    } catch (e) { toast(e.message || 'Could not send voice note'); }
  }
  function stopRecording(send) {
    mediaRef.current.send = send;
    try { mediaRef.current.recorder?.stop(); } catch {}
  }

  // ---------- delete / clear ----------
  function deleteForMe(code, id) {
    setChats((prev) => {
      const c = prev[code]; if (!c) return prev;
      const hidden = new Set(c.hidden); hidden.add(id);
      store.set(`hidden:${code}`, [...hidden]);
      return { ...prev, [code]: { ...c, hidden } };
    });
    setModal(null);
  }
  function deleteForEveryone(code, id) {
    socketRef.current.emit('deleteMessage', { code, id });
    setModal(null);
  }
  function clearChatLocal(code) {
    const ts = Date.now();
    store.set(`cleared:${code}`, ts);
    setChats((prev) => (prev[code] ? { ...prev, [code]: { ...prev[code], clearedAt: ts } } : prev));
    setMenuOpen(false); setItemMenu(null);
    toast('Chat cleared on this device');
  }
  function clearChatEveryone(code) {
    socketRef.current.emit('clearChat', { code }, (res) => {
      if (!res?.ok) return toast(res?.error || 'Not allowed');
      toast('Chat deleted for everyone');
    });
    setModal(null); setMenuOpen(false);
  }
  function markRead(code) {
    setChats((prev) => (prev[code] ? { ...prev, [code]: { ...prev[code], unread: 0 } } : prev));
    setItemMenu(null);
  }

  function copy(textToCopy, label) {
    navigator.clipboard?.writeText(textToCopy).then(() => toast(label || 'Copied'), () => toast('Copy failed'));
  }

  // Open the full-screen viewer for any display picture (room DP, profile DP, member DP).
  function viewImage(url, title, name) {
    if (!url) return;
    setLightbox({ url, title: title || '', name: name || 'photo.jpg' });
  }

  function emitReact(code, id, emoji) {
    socketRef.current?.emit('react', { code, id, emoji });
    setReactingId(null);
  }

  function saveRoom(code, fields) {
    socketRef.current?.emit('updateRoom', { code, ...fields }, (res) => {
      if (!res?.ok) return toast(res?.error || 'Could not update room');
      toast('Room updated');
    });
    setModal(null);
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    store.set('theme', next);
    applyTheme(next);
    setSideMenuOpen(false);
    setMenuOpen(false);
  }

  // ---------- derived ----------
  const sortedChats = Object.values(chats).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const visibleMessages = activeChat
    ? activeChat.messages.filter((m) => !activeChat.hidden.has(m.id) && m.ts > activeChat.clearedAt)
    : [];
  const members = activeChat?.members || [];
  const onlineCount = members.filter((m) => m.online).length;
  const activeTyping = activeCode && typingByRoom[activeCode]
    ? Object.entries(typingByRoom[activeCode]).filter(([id]) => id !== profile.userId).map(([, n]) => n)
    : [];

  function lastPreview(chat) {
    const msgs = chat.messages.filter((m) => !chat.hidden.has(m.id) && m.ts > chat.clearedAt);
    const m = msgs[msgs.length - 1];
    if (!m) return { text: 'No messages yet', ts: chat.lastTs, muted: true };
    if (m.type === 'system') return { text: m.text, ts: m.ts, muted: true };
    if (m.deleted) return { text: '🚫 message deleted', ts: m.ts, muted: true };
    const who = m.userId === profile.userId ? 'You: ' : (chat.members.length > 2 ? `${(m.name || '').split(' ')[0]}: ` : '');
    const body = m.type === 'image' ? '📷 Photo' : m.type === 'voice' ? '🎙️ Voice message' : m.text;
    return { text: who + body, ts: m.ts };
  }

  if (!mounted) return null;

  return (
    <div id="app">
      {/* ================= PROFILE ================= */}
      {screen === 'profile' && (
        <section className="screen center-screen">
          <div className="card">
            <div className="brand">
              <div className="brand-logo">💬</div>
              <h1>ChatRoom</h1>
              <p className="muted">Set up your profile to get started</p>
            </div>
            <AvatarPicker avatar={profile.avatar} name={profile.name} onPick={pickAvatar} />
            <label className="field">
              <span>Your name</span>
              <input value={profile.name} maxLength={40} placeholder="e.g. Debasis"
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && saveProfileBasics()} />
            </label>
            <label className="field">
              <span>About (optional)</span>
              <input value={profile.about} maxLength={80} placeholder="Hey there! I'm using ChatRoom"
                onChange={(e) => setProfile((p) => ({ ...p, about: e.target.value }))} />
            </label>
            <button className="btn primary block" onClick={saveProfileBasics}>Continue</button>
          </div>
        </section>
      )}

      {/* ================= HOME (sidebar + conversation) ================= */}
      {screen === 'home' && (
        <section className={`screen home ${activeCode ? 'show-conversation' : ''}`}>
          {/* ----- Sidebar ----- */}
          <aside className="sidebar">
            <header className="sidebar-header">
              <div className="me" onClick={() => setModal({ type: 'profile' })} title="Profile settings">
                <span className={profile.avatar ? 'viewable' : undefined}
                  onClick={(e) => { if (profile.avatar) { e.stopPropagation(); viewImage(profile.avatar, profile.name, 'my-photo.jpg'); } }}>
                  <Avatar src={profile.avatar} name={profile.name} size={40} />
                </span>
                <span className="strong">{profile.name}</span>
              </div>
              <button className="icon-btn" title="New chat" onClick={() => { setJoinError(''); setModal({ type: 'newchat' }); }}>✏️</button>
              <button className="icon-btn" title="Menu" onClick={(e) => { e.stopPropagation(); setSideMenuOpen((v) => !v); }}>⋮</button>
              {sideMenuOpen && (
                <div className="menu side" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => { setSideMenuOpen(false); setModal({ type: 'profile' }); }}>⚙️ Profile settings</button>
                  <button onClick={() => { setSideMenuOpen(false); setModal({ type: 'newchat' }); }}>➕ New chat</button>
                  <button onClick={toggleTheme}>{theme === 'dark' ? '☀️ Light mode' : '🌙 Dark mode'}</button>
                  {canInstall && <button onClick={openInstall}>📲 Install app</button>}
                </div>
              )}
            </header>

            <div className="chat-list">
              {sortedChats.length === 0 && (
                <div className="empty-list">
                  <p>No chats yet.</p>
                  <button className="btn primary" onClick={() => setModal({ type: 'newchat' })}>Start a chat</button>
                </div>
              )}
              {sortedChats.map((chat) => {
                const code = chat.info.code;
                const pv = lastPreview(chat);
                const typing = typingByRoom[code] && Object.keys(typingByRoom[code]).some((id) => id !== profile.userId);
                return (
                  <div key={code} className={`chat-item ${activeCode === code ? 'active' : ''}`} onClick={() => openChat(code)}>
                    <div className={`chat-item-avatar ${chat.info.image ? 'viewable' : ''}`}
                      onClick={(e) => { if (chat.info.image) { e.stopPropagation(); viewImage(chat.info.image, chat.info.name, 'room-photo.jpg'); } }}>
                      {chat.info.image ? <img src={chat.info.image} alt="" /> : (chat.info.name || '#')[0].toUpperCase()}
                    </div>
                    <div className="chat-item-body">
                      <div className="chat-item-top">
                        <span className="nm strong">{chat.info.name}</span>
                        <span className="chat-item-time">{shortStamp(pv.ts)}</span>
                      </div>
                      <div className="chat-item-bottom">
                        <span className={`chat-item-preview ${pv.muted ? 'muted' : ''}`}>
                          {typing ? <em style={{ color: 'var(--accent)' }}>typing…</em> : pv.text}
                        </span>
                        {chat.unread > 0 && <span className="unread">{chat.unread}</span>}
                      </div>
                    </div>
                    <button className="chat-item-kebab icon-btn" title="Options"
                      onClick={(e) => { e.stopPropagation(); setItemMenu(itemMenu === code ? null : code); }}>⋮</button>
                    {itemMenu === code && (
                      <div className="menu item-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { openChat(code); setItemMenu(null); }}>💬 Open</button>
                        <button onClick={() => markRead(code)}>✓ Mark as read</button>
                        <button onClick={() => setModal({ type: 'invite', code })}>🔗 Invite code</button>
                        <button onClick={() => clearChatLocal(code)}>🧹 Clear chat</button>
                        <button className="danger" onClick={() => setModal({ type: 'confirmLeave', code })}>🚪 Leave chat</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* ----- Conversation ----- */}
          <main className="conversation">
            {!activeChat ? (
              <div className="no-chat">
                <div className="no-chat-inner">
                  <div className="brand-logo">💬</div>
                  <h2>ChatRoom</h2>
                  <p className="muted">Select a chat to start messaging, or create a new room and share the code.</p>
                  <button className="btn primary" onClick={() => setModal({ type: 'newchat' })}>New chat</button>
                </div>
              </div>
            ) : (
              <>
                <header className="chat-header">
                  <button className="icon-btn back conv-back" onClick={() => { setActiveCode(null); activeCodeRef.current = null; }} title="Back">‹</button>
                  <div className="chat-title" onClick={() => setModal({ type: 'roomInfo', code: activeCode })}>
                    <div className={`chat-room-avatar ${activeChat.info.image ? 'viewable' : ''}`}
                      onClick={(e) => { if (activeChat.info.image) { e.stopPropagation(); viewImage(activeChat.info.image, activeChat.info.name, 'room-photo.jpg'); } }}>
                      {activeChat.info.image ? <img src={activeChat.info.image} alt="" /> : (activeChat.info.name || '#')[0].toUpperCase()}
                    </div>
                    <div className="chat-title-text">
                      <div className="nm strong">{activeChat.info.name}</div>
                      <div className="muted tiny">
                        {activeTyping.length ? `${activeTyping[0]} is typing…`
                          : `${members.length} member${members.length === 1 ? '' : 's'}, ${onlineCount} online`}
                      </div>
                    </div>
                  </div>
                  <button className="icon-btn" title="Invite" onClick={() => setModal({ type: 'invite', code: activeCode })}>🔗</button>
                  <button className="icon-btn" title="Menu" onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}>⋮</button>
                  {menuOpen && (
                    <div className="menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setMenuOpen(false); setModal({ type: 'roomInfo', code: activeCode }); }}>ℹ️ Room info</button>
                      <button onClick={() => { setMenuOpen(false); setModal({ type: 'invite', code: activeCode }); }}>🔗 Share invite code</button>
                      <button onClick={() => clearChatLocal(activeCode)}>🧹 Clear chat (only me)</button>
                      <button className="danger" onClick={() => { setMenuOpen(false); setModal({ type: 'confirmClearAll', code: activeCode }); }}>🗑️ Delete chat for everyone</button>
                      <button onClick={() => { setMenuOpen(false); setModal({ type: 'profile' }); }}>⚙️ Profile settings</button>
                      <button className="danger" onClick={() => setModal({ type: 'confirmLeave', code: activeCode })}>🚪 Leave room</button>
                    </div>
                  )}
                </header>

                <div className="messages">
                  {visibleMessages.length === 0 && <div className="system-msg">No messages yet. Say hi! 👋</div>}
                  {visibleMessages.map((m, i) => {
                    const prev = visibleMessages[i - 1];
                    const showDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
                    return (
                      <Fragment key={m.id}>
                        {showDay && <div className="day-sep">{dayLabel(m.ts)}</div>}
                        {m.type === 'system' ? (
                          <div className="system-msg">{m.text}</div>
                        ) : (
                          <MessageBubble
                            m={m} me={profile.userId} isGroup={members.length > 2}
                            onReply={() => setReplyTo(m)}
                            onDelete={() => setModal({ type: 'deleteMsg', code: activeCode, m })}
                            onImage={(media) => setLightbox(media)}
                            reacting={reactingId === m.id}
                            onOpenReact={() => setReactingId(reactingId === m.id ? null : m.id)}
                            onPickReact={(emoji) => emitReact(activeCode, m.id, emoji)}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {activeTyping.length > 0 && (
                  <div className="typing">{activeTyping.join(', ')} {activeTyping.length === 1 ? 'is' : 'are'} typing…</div>
                )}

                {replyTo && (
                  <div className="reply-bar">
                    <div className="reply-bar-text">
                      <span className="reply-bar-name">{replyTo.name}</span>
                      <span className="reply-bar-body">
                        {replyTo.type === 'image' ? '📷 Photo' : replyTo.type === 'voice' ? '🎙️ Voice message' : replyTo.text}
                      </span>
                    </div>
                    <button className="icon-btn" onClick={() => setReplyTo(null)}>✕</button>
                  </div>
                )}

                {recording ? (
                  <div className="recording-bar">
                    <div className="rec-dot" />
                    <span>{fmtDuration(recSeconds)}</span>
                    <span className="muted">Recording…</span>
                    <span className="spacer" />
                    <button className="btn ghost small" onClick={() => stopRecording(false)}>Cancel</button>
                    <button className="btn primary small" onClick={() => stopRecording(true)}>Send</button>
                  </div>
                ) : (
                  <footer className="composer">
                    <button className="icon-btn" title="Attach image" onClick={() => fileInputRef.current?.click()}>📎</button>
                    <input ref={fileInputRef} type="file" accept="image/*" hidden
                      onChange={(e) => { sendImage(e.target.files[0]); e.target.value = ''; }} />
                    <textarea rows={1} placeholder="Type a message" value={text}
                      onChange={(e) => onTextChange(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } }} />
                    {text.trim()
                      ? <button className="icon-btn round send" title="Send" onClick={sendText}>➤</button>
                      : <button className="icon-btn round" title="Record voice note" onClick={startRecording}>🎙️</button>}
                  </footer>
                )}
              </>
            )}
          </main>
        </section>
      )}

      {/* ================= MODALS ================= */}
      {modal && (
        <ModalRoot onClose={() => setModal(null)}>
          {modal.type === 'newchat' && (
            <div>
              <h3>New chat</h3>
              <div className="tabs">
                <button className={`tab ${tab === 'join' ? 'active' : ''}`} onClick={() => setTab('join')}>Join by code</button>
                <button className={`tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>Create room</button>
              </div>
              {tab === 'join' ? (
                <div>
                  <label className="field">
                    <span>Invite / Room code</span>
                    <input value={joinCode} maxLength={6} placeholder="ABC123" autoFocus
                      style={{ textTransform: 'uppercase', letterSpacing: 4, fontWeight: 700 }}
                      onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === 'Enter' && doJoin()} />
                  </label>
                  <button className="btn primary block" onClick={() => doJoin()}>Join room</button>
                  <p className="error">{joinError}</p>
                </div>
              ) : (
                <div>
                  <label className="field">
                    <span>Room name</span>
                    <input value={createName} maxLength={60} placeholder="e.g. Family group" autoFocus
                      onChange={(e) => setCreateName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && doCreate()} />
                  </label>
                  <button className="btn primary block" onClick={doCreate}>Create &amp; get code</button>
                </div>
              )}
            </div>
          )}

          {modal.type === 'invite' && (
            <div>
              <h3>Invite people</h3>
              <p className="muted tiny">Share this code or link. Anyone with it can join.</p>
              <div className="invite-code-box"><div className="code">{modal.code}</div></div>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => copy(modal.code, 'Code copied')}>Copy code</button>
                <button className="btn primary" onClick={() => copy(`${window.location.origin}?room=${modal.code}`, 'Link copied')}>Copy link</button>
              </div>
            </div>
          )}

          {modal.type === 'roomInfo' && chats[modal.code] && (
            <RoomInfo
              chat={chats[modal.code]}
              isOwner={chats[modal.code].info.ownerId === profile.userId}
              meId={profile.userId}
              onPickFail={() => toast('Could not load that image')}
              onSave={(fields) => saveRoom(modal.code, fields)}
              onView={viewImage}
              onClose={() => setModal(null)}
            />
          )}

          {modal.type === 'profile' && (
            <ProfileSettings profile={profile} onPick={pickAvatar} onSave={saveProfileSettings} onView={viewImage} onClose={() => setModal(null)} />
          )}

          {modal.type === 'deleteMsg' && (
            <div>
              <h3>Delete message?</h3>
              <p className="muted">This can't be undone.</p>
              <div className="modal-actions" style={{ flexDirection: 'column' }}>
                <button className="btn ghost" onClick={() => deleteForMe(modal.code, modal.m.id)}>Delete for me</button>
                {(modal.m.userId === profile.userId || chats[modal.code]?.info.ownerId === profile.userId) && (
                  <button className="btn danger" onClick={() => deleteForEveryone(modal.code, modal.m.id)}>Delete for everyone</button>
                )}
                <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
              </div>
            </div>
          )}

          {modal.type === 'confirmClearAll' && (
            <div>
              <h3>Delete chat for everyone?</h3>
              <p className="muted">All messages in this room will be permanently removed for all members.</p>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn danger" onClick={() => clearChatEveryone(modal.code)}>Delete</button>
              </div>
            </div>
          )}

          {modal.type === 'confirmLeave' && (
            <div>
              <h3>Leave this chat?</h3>
              <p className="muted">It will be removed from your chat list. You can rejoin later with the code.</p>
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn danger" onClick={() => leaveChat(modal.code)}>Leave</button>
              </div>
            </div>
          )}
        </ModalRoot>
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          {lightbox.title && <div className="lightbox-title" onClick={(e) => e.stopPropagation()}>{lightbox.title}</div>}
          <button className="lightbox-close" title="Close" onClick={() => setLightbox(null)}>✕</button>
          <img src={lightbox.url} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-dl" onClick={(e) => { e.stopPropagation(); downloadMedia(lightbox.url, lightbox.name || 'image.jpg'); }}>⬇ Download</button>
        </div>
      )}

      {bannerOpen && canInstall && (
        <div className="install-banner">
          <div className="install-logo">💬</div>
          <div className="install-text">
            <div className="strong">Install ChatRoom</div>
            {installEvt ? (
              <div className="muted tiny">Add it to your home screen for a full-screen, app-like experience.</div>
            ) : (
              <div className="muted tiny">Tap <b>Share</b> <span aria-hidden>⎙</span> then <b>“Add to Home Screen”</b>.</div>
            )}
          </div>
          {installEvt && <button className="btn primary small" onClick={doInstall}>Install</button>}
          <button className="install-x" onClick={dismissInstall} title="Dismiss">✕</button>
        </div>
      )}

      <div className={`toast ${toastMsg ? 'show' : ''}`}>{toastMsg}</div>
    </div>
  );
}

/* ===================== sub components ===================== */

function AvatarPicker({ avatar, onPick }) {
  const ref = useRef(null);
  return (
    <div className="avatar-picker">
      <label className="avatar-edit" onClick={() => ref.current?.click()}>
        {avatar ? <img src={avatar} alt="avatar" /> : <span className="fallback">+</span>}
        <div className="avatar-cam">📷 Photo</div>
      </label>
      <input ref={ref} type="file" accept="image/*" hidden
        onChange={(e) => { onPick(e.target.files[0]); e.target.value = ''; }} />
    </div>
  );
}

function applyTheme(t) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'light' ? '#f0f2f5' : '#111b21');
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function mediaFileName(m) {
  if (m.type === 'image') return `photo-${m.id}.jpg`;
  if (m.type === 'voice') return `voice-${m.id}.webm`;
  return `file-${m.id}`;
}

function MessageBubble({ m, me, isGroup, onReply, onDelete, onImage, reacting, onOpenReact, onPickReact }) {
  const out = m.userId === me;
  const overlayMeta = !m.deleted && m.type === 'image' && m.media && !m.text;
  const [dx, setDx] = useState(0);
  const touch = useRef({ x: 0, y: 0, swiping: false, lpTimer: null, suppressClick: false });

  const myReaction = m.reactions ? m.reactions[me] : null;
  const reactionCounts = {};
  if (m.reactions) for (const e of Object.values(m.reactions)) reactionCounts[e] = (reactionCounts[e] || 0) + 1;

  function onTouchStart(e) {
    if (m.deleted) return;
    const t = e.touches[0];
    touch.current.x = t.clientX; touch.current.y = t.clientY;
    touch.current.swiping = false; touch.current.suppressClick = false;
    clearTimeout(touch.current.lpTimer);
    touch.current.lpTimer = setTimeout(() => {
      if (!touch.current.swiping) { touch.current.suppressClick = true; onOpenReact(); }
    }, 500);
  }
  function onTouchMove(e) {
    const t = e.touches[0];
    const ddx = t.clientX - touch.current.x, ddy = t.clientY - touch.current.y;
    if (Math.abs(ddx) > 8 || Math.abs(ddy) > 8) clearTimeout(touch.current.lpTimer);
    if (Math.abs(ddx) > Math.abs(ddy) && ddx > 6) { touch.current.swiping = true; touch.current.suppressClick = true; setDx(Math.min(ddx, 80)); }
  }
  function onTouchEnd() {
    clearTimeout(touch.current.lpTimer);
    if (dx > 55) onReply();
    setDx(0); touch.current.swiping = false;
  }

  return (
    <div className={`msg-row ${out ? 'out' : 'in'}`}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}>
      {dx > 10 && <span className="swipe-reply">↩</span>}
      <div className={`bubble ${m.deleted ? 'deleted' : ''} ${reacting ? 'acting' : ''} ${m.type === 'image' && m.media && !m.deleted ? 'image' : ''}`}>
        {!out && isGroup && !m.deleted && <div className="sender">{m.name}</div>}
        {!m.deleted && (
          <div className="msg-actions">
            <button title="React" onClick={(e) => { e.stopPropagation(); onOpenReact(); }}>😀</button>
            {m.media && <button title="Download" onClick={() => downloadMedia(m.media.url, m.media.name || mediaFileName(m))}>⬇</button>}
            <button title="Reply" onClick={onReply}>↩</button>
            <button title="Delete" onClick={onDelete}>🗑</button>
          </div>
        )}
        {reacting && (
          <div className="react-picker" onClick={(e) => e.stopPropagation()}>
            {REACTIONS.map((emo) => (
              <button key={emo} className={myReaction === emo ? 'on' : ''} onClick={() => onPickReact(emo)}>{emo}</button>
            ))}
          </div>
        )}
        {m.deleted ? (
          <div className="text">🚫 This message was deleted</div>
        ) : (
          <>
            {m.replyTo && (
              <div className="reply-quote">
                <span className="rq-name">{m.replyTo.name}</span>
                <span className="rq-body">{m.replyTo.preview}</span>
              </div>
            )}
            {m.type === 'image' && m.media && (
              <div className="photo-wrap">
                <img className="photo" src={m.media.url} alt="" draggable={false}
                  onClick={() => { if (touch.current.suppressClick) { touch.current.suppressClick = false; return; } onImage(m.media); }}
                  onContextMenu={(e) => e.preventDefault()} />
                {overlayMeta && <div className="photo-overlay"><span>{formatTime(m.ts)}</span></div>}
              </div>
            )}
            {m.type === 'voice' && m.media && <VoiceNote src={m.media.url} duration={m.media.duration} name={m.media.name} />}
            {m.type === 'file' && m.media && <a className="file-link" href={m.media.url} download={m.media.name} target="_blank" rel="noreferrer">📄 {m.media.name}</a>}
            {m.text && <div className={`text ${m.type === 'image' ? 'caption' : ''}`}>{m.text}</div>}
          </>
        )}
        {!overlayMeta && <span className="meta">{formatTime(m.ts)}</span>}
        {Object.keys(reactionCounts).length > 0 && (
          <div className="reactions" onClick={(e) => { e.stopPropagation(); onOpenReact(); }}>
            {Object.entries(reactionCounts).map(([emo, n]) => (
              <span key={emo} className={`react-pill ${myReaction === emo ? 'mine' : ''}`}>{emo}{n > 1 ? ` ${n}` : ''}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileSettings({ profile, onPick, onSave, onView, onClose }) {
  const [name, setName] = useState(profile.name);
  const [about, setAbout] = useState(profile.about || '');
  return (
    <div>
      <h3>Profile settings</h3>
      <AvatarPicker avatar={profile.avatar} name={profile.name} onPick={onPick} />
      {profile.avatar && (
        <div className="view-photo-row">
          <button className="btn ghost small" onClick={() => onView(profile.avatar, profile.name, 'my-photo.jpg')}>🔍 View photo</button>
        </div>
      )}
      <label className="field"><span>Name</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>About</span>
        <input value={about} maxLength={80} onChange={(e) => setAbout(e.target.value)} /></label>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave({ name, about, avatar: profile.avatar })}>Save</button>
      </div>
    </div>
  );
}

function RoomInfo({ chat, isOwner, meId, onPickFail, onSave, onView, onClose }) {
  const [name, setName] = useState(chat.info.name);
  const [description, setDescription] = useState(chat.info.description || '');
  const [image, setImage] = useState(chat.info.image || '');
  async function pick(file) {
    if (!file) return;
    try { setImage(await fileToCompressedDataURL(file, 256)); } catch { onPickFail(); }
  }
  return (
    <div>
      <h3>Room info</h3>
      {isOwner ? (
        <>
          <AvatarPicker avatar={image} name={name} onPick={pick} />
          {image && (
            <div className="view-photo-row">
              <button className="btn ghost small" onClick={() => onView(image, name, 'room-photo.jpg')}>🔍 View photo</button>
            </div>
          )}
        </>
      ) : (
        <div className={`avatar-picker ${image ? 'viewable' : ''}`}
          onClick={() => image && onView(image, name, 'room-photo.jpg')}>
          <Avatar src={image} name={name} size={110} />
        </div>
      )}
      {isOwner ? (
        <>
          <label className="field"><span>Room name</span>
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Description</span>
            <textarea value={description} maxLength={500} rows={3} placeholder="Add a room description" onChange={(e) => setDescription(e.target.value)} /></label>
        </>
      ) : (
        <>
          <h3 style={{ textAlign: 'center', marginTop: 8 }}>{name}</h3>
          <p className="muted" style={{ textAlign: 'center', whiteSpace: 'pre-wrap' }}>{description || 'No description'}</p>
        </>
      )}
      <div className="invite-code-box">
        <div className="muted tiny">Invite code</div>
        <div className="code">{chat.info.code}</div>
      </div>
      <h4 className="muted" style={{ margin: '12px 0 6px' }}>Members ({chat.members.length})</h4>
      <div>
        {chat.members.map((m) => (
          <div className="member-row" key={m.userId}>
            <span className={m.avatar ? 'viewable' : undefined}
              onClick={() => m.avatar && onView(m.avatar, m.name, 'photo.jpg')}>
              <Avatar src={m.avatar} name={m.name} size={42} />
            </span>
            <div className="who">
              <div className="nm strong">{m.name}{m.userId === meId ? ' (you)' : ''}{chat.info.ownerId === m.userId ? ' • admin' : ''}</div>
              <div className="muted tiny">{m.online ? 'online' : lastSeenLabel(m.lastSeen)}</div>
            </div>
            <div className={`dot ${m.online ? 'on' : 'off'}`} />
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Close</button>
        {isOwner && <button className="btn primary" onClick={() => onSave({ name: name.trim() || chat.info.name, description, image })}>Save</button>}
      </div>
    </div>
  );
}

function ModalRoot({ children, onClose }) {
  return (
    <div className="modal-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">{children}</div>
    </div>
  );
}
