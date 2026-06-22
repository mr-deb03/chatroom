'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import Avatar from './components/Avatar';
import VoiceNote from './components/VoiceNote';
import {
  uid, formatTime, dayKey, dayLabel, fmtDuration, lastSeenLabel,
  store, uploadFile, fileToCompressedDataURL,
} from './lib/util';

export default function Page() {
  const [mounted, setMounted] = useState(false);
  const [screen, setScreen] = useState('profile'); // profile | lobby | chat
  const [profile, setProfile] = useState({ userId: '', name: '', about: '', avatar: '' });

  const [tab, setTab] = useState('join');
  const [joinCode, setJoinCode] = useState('');
  const [createName, setCreateName] = useState('');
  const [joinError, setJoinError] = useState('');
  const [recent, setRecent] = useState([]);

  const [room, setRoom] = useState(null); // { code, name, ownerId }
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [typingUsers, setTypingUsers] = useState({});
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [lightbox, setLightbox] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  // local-only message hiding (delete for me) + clear chat for me
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [clearedAt, setClearedAt] = useState(0);

  // recording
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  const socketRef = useRef(null);
  const roomRef = useRef(null);
  const profileRef = useRef(profile);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimeoutsRef = useRef({}); // others' typing timeouts
  const selfTypingRef = useRef(null);
  const mediaRef = useRef({ recorder: null, chunks: [], stream: null, timer: null, send: false });

  const toast = useCallback((m) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(''), 2200);
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    setMounted(true);
    let p = store.get('profile', null);
    if (!p || !p.userId) p = { userId: uid(), name: '', about: '', avatar: '' };
    setProfile(p);
    profileRef.current = p;
    setRecent(store.get('recentRooms', []));
    if (p.name) setScreen('lobby');

    // deep link: ?room=CODE
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room');
    if (r) {
      setJoinCode(r.toUpperCase());
      setTab('join');
    }

    // socket.io-client is loaded only in the browser (dynamic import) so it never
    // enters the SSR/server bundle — avoids the engine.io-client vendor-chunk error.
    let cancelled = false;
    import('socket.io-client').then(({ io }) => {
      if (cancelled) return;
      const socket = io({ transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('message', (m) => {
        if (!roomRef.current) return;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      });
      socket.on('messageDeleted', ({ id }) => {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, deleted: true, text: '', media: null } : m)));
      });
      socket.on('chatCleared', () => setMessages([]));
      socket.on('presence', ({ code, members }) => {
        if (roomRef.current && roomRef.current.code === code) setMembers(members);
      });
      socket.on('typing', ({ userId, name, isTyping }) => {
        setTypingUsers((prev) => {
          const next = { ...prev };
          if (isTyping) next[userId] = name;
          else delete next[userId];
          return next;
        });
        clearTimeout(typingTimeoutsRef.current[userId]);
        if (isTyping) {
          typingTimeoutsRef.current[userId] = setTimeout(() => {
            setTypingUsers((prev) => {
              const next = { ...prev };
              delete next[userId];
              return next;
            });
          }, 4000);
        }
      });
    });

    return () => { cancelled = true; socketRef.current?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { roomRef.current = room; }, [room]);

  // auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingUsers]);

  // close header menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const h = () => setMenuOpen(false);
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [menuOpen]);

  // recording timer
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
    setScreen('lobby');
  }

  async function pickAvatar(file) {
    if (!file) return;
    try {
      const dataUrl = await fileToCompressedDataURL(file, 256);
      setProfile((p) => ({ ...p, avatar: dataUrl }));
    } catch {
      toast('Could not load that image');
    }
  }

  function saveProfileSettings(updated) {
    const p = { ...profile, ...updated, name: (updated.name ?? profile.name).trim() || profile.name };
    store.set('profile', p);
    setProfile(p);
    socketRef.current?.emit('updateProfile', { profile: p });
    setModal(null);
    toast('Profile updated');
  }

  // ---------- recent rooms ----------
  function rememberRoom(r) {
    const list = store.get('recentRooms', []).filter((x) => x.code !== r.code);
    list.unshift({ code: r.code, name: r.name, ts: Date.now() });
    const trimmed = list.slice(0, 8);
    store.set('recentRooms', trimmed);
    setRecent(trimmed);
  }
  function forgetRoom(code) {
    const list = store.get('recentRooms', []).filter((x) => x.code !== code);
    store.set('recentRooms', list);
    setRecent(list);
  }

  // ---------- join / create ----------
  function enterRoom(roomInfo, history, mem) {
    setRoom(roomInfo);
    roomRef.current = roomInfo;
    setMessages(history || []);
    setMembers(mem || []);
    setReplyTo(null);
    setText('');
    setTypingUsers({});
    setHiddenIds(new Set(store.get(`hidden:${roomInfo.code}`, [])));
    setClearedAt(store.get(`cleared:${roomInfo.code}`, 0));
    rememberRoom(roomInfo);
    setScreen('chat');
  }

  function doJoin(code) {
    setJoinError('');
    const c = (code || joinCode).toUpperCase().trim();
    if (c.length < 4) return setJoinError('Enter a valid room code');
    socketRef.current.emit('join', { code: c, profile }, (res) => {
      if (!res?.ok) return setJoinError(res?.error || 'Could not join');
      enterRoom(res.room, res.messages, res.members);
    });
  }

  function doCreate() {
    const name = createName.trim() || `${profile.name}'s room`;
    socketRef.current.emit('createRoom', { name, profile }, (res) => {
      if (!res?.ok) return toast('Could not create room');
      socketRef.current.emit('join', { code: res.code, profile }, (jr) => {
        if (!jr?.ok) return toast(jr?.error || 'Could not open room');
        enterRoom(jr.room, jr.messages, jr.members);
        setModal({ type: 'invite', code: res.code });
      });
    });
  }

  function leaveRoom() {
    socketRef.current?.emit('leave');
    setRoom(null);
    roomRef.current = null;
    setMessages([]);
    setMembers([]);
    setMenuOpen(false);
    setModal(null);
    setScreen('lobby');
  }

  // ---------- sending ----------
  function emitTyping(isTyping) {
    socketRef.current?.emit('typing', { isTyping });
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
      id: replyTo.id,
      name: replyTo.name,
      preview:
        replyTo.type === 'image' ? '📷 Photo' :
        replyTo.type === 'voice' ? '🎙️ Voice message' :
        (replyTo.text || ''),
    };
  }

  function sendText() {
    const t = text.trim();
    if (!t) return;
    socketRef.current.emit('message', {
      type: 'text', text: t, name: profile.name, avatar: profile.avatar, replyTo: buildReplyMeta(),
    });
    setText('');
    setReplyTo(null);
    emitTyping(false);
    clearTimeout(selfTypingRef.current);
  }

  async function sendImage(file) {
    if (!file) return;
    try {
      toast('Uploading…');
      const media = await uploadFile(file);
      socketRef.current.emit('message', {
        type: 'image', media, text: text.trim(), name: profile.name, avatar: profile.avatar, replyTo: buildReplyMeta(),
      });
      setText('');
      setReplyTo(null);
    } catch (e) {
      toast(e.message || 'Upload failed');
    }
  }

  // ---------- voice notes ----------
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
      setRecSeconds(0);
      setRecording(true);
    } catch {
      toast('Microphone blocked. Use http://localhost or HTTPS and allow access.');
    }
  }

  async function onRecordingStop() {
    const { chunks, stream, recorder, send, startTime } = mediaRef.current;
    stream?.getTracks().forEach((t) => t.stop());
    const duration = Math.max(1, Math.round((Date.now() - (startTime || Date.now())) / 1000));
    setRecording(false);
    if (!send || !chunks.length) return;
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      toast('Sending voice note…');
      const media = await uploadFile(blob, `voice-${Date.now()}.webm`);
      media.duration = duration;
      socketRef.current.emit('message', {
        type: 'voice', media, name: profile.name, avatar: profile.avatar, replyTo: buildReplyMeta(),
      });
      setReplyTo(null);
    } catch (e) {
      toast(e.message || 'Could not send voice note');
    }
  }

  function stopRecording(send) {
    mediaRef.current.send = send;
    try { mediaRef.current.recorder?.stop(); } catch {}
  }

  // ---------- delete / clear ----------
  function deleteForMe(id) {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      store.set(`hidden:${room.code}`, [...next]);
      return next;
    });
    setModal(null);
  }
  function deleteForEveryone(id) {
    socketRef.current.emit('deleteMessage', { id });
    setModal(null);
  }
  function clearChatLocal() {
    const ts = Date.now();
    store.set(`cleared:${room.code}`, ts);
    setClearedAt(ts);
    setMenuOpen(false);
    toast('Chat cleared on this device');
  }
  function clearChatEveryone() {
    socketRef.current.emit('clearChat', null, (res) => {
      if (!res?.ok) return toast(res?.error || 'Not allowed');
      toast('Chat deleted for everyone');
    });
    setModal(null);
    setMenuOpen(false);
  }

  function copy(textToCopy, label) {
    navigator.clipboard?.writeText(textToCopy).then(() => toast(label || 'Copied'), () => toast('Copy failed'));
  }

  // ---------- derived ----------
  const visibleMessages = messages.filter((m) => !hiddenIds.has(m.id) && m.ts > clearedAt);
  const onlineCount = members.filter((m) => m.online).length;
  const othersTyping = Object.entries(typingUsers).filter(([id]) => id !== profile.userId).map(([, n]) => n);

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

      {/* ================= LOBBY ================= */}
      {screen === 'lobby' && (
        <section className="screen center-screen">
          <div className="card">
            <div className="lobby-me" onClick={() => setModal({ type: 'profile' })}>
              <Avatar src={profile.avatar} name={profile.name} size={52} />
              <div>
                <div className="strong">{profile.name}</div>
                <div className="muted tiny">{profile.about || 'Tap to edit profile'}</div>
              </div>
            </div>

            <div className="tabs">
              <button className={`tab ${tab === 'join' ? 'active' : ''}`} onClick={() => setTab('join')}>Join a room</button>
              <button className={`tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>Create a room</button>
            </div>

            {tab === 'join' ? (
              <div>
                <label className="field">
                  <span>Invite / Room code</span>
                  <input value={joinCode} maxLength={6} placeholder="ABC123"
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
                  <input value={createName} maxLength={60} placeholder="e.g. Family group"
                    onChange={(e) => setCreateName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doCreate()} />
                </label>
                <button className="btn primary block" onClick={doCreate}>Create &amp; get code</button>
              </div>
            )}

            {recent.length > 0 && (
              <div className="recent">
                <h4>Recent rooms</h4>
                {recent.map((r) => (
                  <div className="recent-item" key={r.code} onClick={() => doJoin(r.code)}>
                    <div className="recent-avatar">{(r.name || '#')[0].toUpperCase()}</div>
                    <div className="recent-meta">
                      <div className="nm strong">{r.name}</div>
                      <div className="code">Code: {r.code}</div>
                    </div>
                    <button className="recent-del" title="Remove"
                      onClick={(e) => { e.stopPropagation(); forgetRoom(r.code); }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ================= CHAT ================= */}
      {screen === 'chat' && room && (
        <section className="screen chat">
          <header className="chat-header">
            <button className="icon-btn back" onClick={leaveRoom} title="Back">‹</button>
            <div className="chat-title" onClick={() => setModal({ type: 'members' })}>
              <div className="chat-room-avatar">{(room.name || '#')[0].toUpperCase()}</div>
              <div className="chat-title-text">
                <div className="nm strong">{room.name}</div>
                <div className="muted tiny">
                  {othersTyping.length ? `${othersTyping[0]} is typing…`
                    : `${members.length} member${members.length === 1 ? '' : 's'}, ${onlineCount} online`}
                </div>
              </div>
            </div>
            <button className="icon-btn" title="Invite" onClick={() => setModal({ type: 'invite', code: room.code })}>🔗</button>
            <button className="icon-btn" title="Menu"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}>⋮</button>
            {menuOpen && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { setMenuOpen(false); setModal({ type: 'members' }); }}>👥 Members</button>
                <button onClick={() => { setMenuOpen(false); setModal({ type: 'invite', code: room.code }); }}>🔗 Share invite code</button>
                <button onClick={clearChatLocal}>🧹 Clear chat (only me)</button>
                <button className="danger" onClick={() => { setMenuOpen(false); setModal({ type: 'confirmClearAll' }); }}>🗑️ Delete chat for everyone</button>
                <button onClick={() => { setMenuOpen(false); setModal({ type: 'profile' }); }}>⚙️ Profile settings</button>
                <button onClick={leaveRoom}>🚪 Leave room</button>
              </div>
            )}
          </header>

          <div className="messages">
            {visibleMessages.length === 0 && (
              <div className="system-msg">No messages yet. Say hi! 👋</div>
            )}
            {visibleMessages.map((m, i) => {
              const prev = visibleMessages[i - 1];
              const showDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
              return (
                <div key={m.id}>
                  {showDay && <div className="day-sep">{dayLabel(m.ts)}</div>}
                  {m.type === 'system' ? (
                    <div className="system-msg">{m.text}</div>
                  ) : (
                    <MessageBubble
                      m={m}
                      me={profile.userId}
                      isGroup={members.length > 2}
                      onReply={() => setReplyTo(m)}
                      onDelete={() => setModal({ type: 'deleteMsg', m })}
                      onImage={(src) => setLightbox(src)}
                    />
                  )}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {othersTyping.length > 0 && (
            <div className="typing">{othersTyping.join(', ')} {othersTyping.length === 1 ? 'is' : 'are'} typing…</div>
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
              <textarea
                rows={1}
                placeholder="Type a message"
                value={text}
                onChange={(e) => onTextChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
                }}
              />
              {text.trim() ? (
                <button className="icon-btn round send" title="Send" onClick={sendText}>➤</button>
              ) : (
                <button className="icon-btn round" title="Record voice note" onClick={startRecording}>🎙️</button>
              )}
            </footer>
          )}
        </section>
      )}

      {/* ================= MODALS ================= */}
      {modal && (
        <ModalRoot onClose={() => setModal(null)}>
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

          {modal.type === 'members' && (
            <div>
              <h3>Members ({members.length})</h3>
              <div>
                {members.map((m) => (
                  <div className="member-row" key={m.userId}>
                    <Avatar src={m.avatar} name={m.name} size={42} />
                    <div className="who">
                      <div className="nm strong">{m.name}{m.userId === profile.userId ? ' (you)' : ''}{room.ownerId === m.userId ? ' • admin' : ''}</div>
                      <div className="muted tiny">{m.online ? 'online' : lastSeenLabel(m.lastSeen)}</div>
                    </div>
                    <div className={`dot ${m.online ? 'on' : 'off'}`} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {modal.type === 'profile' && (
            <ProfileSettings profile={profile} onPick={pickAvatar} onSave={saveProfileSettings} onClose={() => setModal(null)} />
          )}

          {modal.type === 'deleteMsg' && (
            <div>
              <h3>Delete message?</h3>
              <p className="muted">This can't be undone.</p>
              <div className="modal-actions" style={{ flexDirection: 'column' }}>
                <button className="btn ghost" onClick={() => deleteForMe(modal.m.id)}>Delete for me</button>
                {modal.m.userId === profile.userId || room.ownerId === profile.userId ? (
                  <button className="btn danger" onClick={() => deleteForEveryone(modal.m.id)}>Delete for everyone</button>
                ) : null}
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
                <button className="btn danger" onClick={clearChatEveryone}>Delete</button>
              </div>
            </div>
          )}
        </ModalRoot>
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox('')}>
          <img src={lightbox} alt="" />
        </div>
      )}

      <div className={`toast ${toastMsg ? 'show' : ''}`}>{toastMsg}</div>
    </div>
  );
}

/* ===================== sub components ===================== */

function AvatarPicker({ avatar, name, onPick }) {
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

function MessageBubble({ m, me, isGroup, onReply, onDelete, onImage }) {
  const out = m.userId === me;
  return (
    <div className={`msg-row ${out ? 'out' : 'in'}`}>
      <div className={`bubble ${m.deleted ? 'deleted' : ''}`}>
        {!out && isGroup && !m.deleted && <div className="sender">{m.name}</div>}

        {!m.deleted && (
          <div className="msg-actions">
            <button title="Reply" onClick={onReply}>↩</button>
            <button title="Delete" onClick={onDelete}>🗑</button>
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
              <img className="photo" src={m.media.url} alt="" onClick={() => onImage(m.media.url)} />
            )}
            {m.type === 'voice' && m.media && (
              <VoiceNote src={m.media.url} duration={m.media.duration} />
            )}
            {m.type === 'file' && m.media && (
              <a className="file-link" href={m.media.url} download={m.media.name} target="_blank" rel="noreferrer">📄 {m.media.name}</a>
            )}
            {m.text && <div className={`text ${m.type === 'image' ? 'caption' : ''}`}>{m.text}</div>}
          </>
        )}
        <span className="meta">{formatTime(m.ts)}</span>
      </div>
    </div>
  );
}

function ProfileSettings({ profile, onPick, onSave, onClose }) {
  const [name, setName] = useState(profile.name);
  const [about, setAbout] = useState(profile.about || '');
  return (
    <div>
      <h3>Profile settings</h3>
      <AvatarPicker avatar={profile.avatar} name={profile.name} onPick={onPick} />
      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>About</span>
        <input value={about} maxLength={80} onChange={(e) => setAbout(e.target.value)} />
      </label>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave({ name, about, avatar: profile.avatar })}>Save</button>
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
