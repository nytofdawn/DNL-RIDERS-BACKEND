/* Rider Radio — client
 * Pure group voice calling over a WebRTC mesh, signaled via Socket.IO.
 * No accounts. A room is just a shared channel name.
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Free public TURN relay (openrelay/metered) — helps riders on cellular/NAT-heavy
  // networks actually hear each other. Swap in your own TURN credentials for
  // production reliability; these public ones are rate-limited.
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

const BACKEND_URL = 'https://dnl-riders-backend.onrender.com';   

const joinScreen = document.getElementById('joinScreen');
const callScreen = document.getElementById('callScreen');
const joinForm = document.getElementById('joinForm');
const roomInput = document.getElementById('roomInput');
const nameInput = document.getElementById('nameInput');
const joinBtn = document.getElementById('joinBtn');
const joinError = document.getElementById('joinError');

const channelNameLabel = document.getElementById('channelNameLabel');
const connStatus = document.getElementById('connStatus');
const dial = document.getElementById('dial');
const riderNodes = document.getElementById('riderNodes');
const riderCount = document.getElementById('riderCount');
const riderList = document.getElementById('riderList');
const talkToggle = document.getElementById('talkToggle');
const talkLabel = document.getElementById('talkLabel');
const micIconOn = document.getElementById('micIconOn');
const micIconOff = document.getElementById('micIconOff');
const leaveBtn = document.getElementById('leaveBtn');
const audioSinks = document.getElementById('audioSinks');
const toastEl = document.getElementById('toast');

let socket = null;
let localStream = null;
let selfId = null;
let selfName = 'Rider';
let roomId = '';
let muted = false;
let audioCtx = null;

// peerId -> { pc, audioEl, name, analyser, listItem, node, rafId }
const peers = new Map();

function showToast(msg, ms = 3200) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
}

/* ---------------- Audio unlock (mobile autoplay policy) ---------------- */
// Runs inside the user's tap on "Join" — this "unlocks" audio playback for
// every <audio> element we create later in this page session, on iOS Safari
// and Chrome/Android alike.
function unlockAudioPlayback() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const buffer = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (e) {
    // non-fatal — some browsers don't need this at all
  }
}

/* ---------------- Join flow ---------------- */
joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  joinError.hidden = true;

  const room = roomInput.value.trim();
  if (!room) return;
  roomId = room;
  selfName = (nameInput.value.trim() || 'Rider').slice(0, 24);

  joinBtn.disabled = true;
  joinBtn.textContent = 'CONNECTING…';

  unlockAudioPlayback();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    joinBtn.disabled = false;
    joinBtn.innerHTML = 'KEY UP &amp; JOIN';
    joinError.hidden = false;
    joinError.textContent = 'Microphone access is required to get on the channel. Please allow it and try again.';
    return;
  }

  connectSocket();
});

function connectSocket() {
  socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    selfId = socket.id;
    socket.emit('join-room', { roomId, name: selfName });
  });

  socket.on('room-joined', ({ peers: existingPeers }) => {
    enterCallScreen();
    existingPeers.forEach((p) => {
      addRiderNode(p.id, p.name, false);
    });
    updateCounts();
  });

  socket.on('peer-joined', ({ id, name }) => {
    addRiderNode(id, name, false);
    updateCounts();
    // We are already in the room — call the newcomer.
    createPeerConnection(id, true, name);
    showToast(`${name} joined the channel`);
  });

  socket.on('signal', async ({ from, data }) => {
    let entry = peers.get(from);
    if (!entry) {
      entry = createPeerConnection(from, false, entry?.name || 'Rider');
    }
    const pc = entry.pc;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: pc.localDescription });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data)); } catch (_) {}
      }
    } catch (err) {
      console.error('signal handling error', err);
    }
  });

  socket.on('peer-left', ({ id }) => {
    removePeer(id);
    updateCounts();
  });

  socket.on('disconnect', () => {
    connStatus.textContent = 'RECONNECTING…';
  });

  socket.io.on('reconnect', () => {
    socket.emit('join-room', { roomId, name: selfName });
  });
}

/* ---------------- WebRTC mesh ---------------- */
function createPeerConnection(peerId, isInitiator, name) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: peerId, data: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      // let peer-left (from server) do the cleanup; this just guards stragglers
    }
  };

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.playsInline = true;
  audioSinks.appendChild(audioEl);

  pc.ontrack = (e) => {
    audioEl.srcObject = e.streams[0];
    const playPromise = audioEl.play();
    if (playPromise) playPromise.catch(() => {
      // If a browser still blocks it, unlock again on next tap anywhere.
      document.addEventListener('click', () => audioEl.play().catch(() => {}), { once: true });
    });
    attachSpeakingDetector(peerId, e.streams[0]);
  };

  let entry = peers.get(peerId);
  if (!entry) entry = addRiderNode(peerId, name, false);
  entry.pc = pc;
  entry.audioEl = audioEl;
  peers.set(peerId, entry);

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', { to: peerId, data: pc.localDescription });
      } catch (err) {
        console.error('negotiation error', err);
      }
    };
  }

  connStatus.textContent = 'LIVE';
  return entry;
}

function attachSpeakingDetector(peerId, stream) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    const entry = peers.get(peerId);
    if (!entry) return;
    entry.analyser = analyser;

    function tick() {
      const e = peers.get(peerId);
      if (!e) return; // peer left, stop loop
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const talking = avg > 12;
      setTalking(peerId, talking);
      e.rafId = requestAnimationFrame(tick);
    }
    tick();
  } catch (err) {
    // Web Audio not available for detection — voice still works fine either way
  }
}

function setTalking(peerId, talking) {
  const entry = peers.get(peerId);
  if (!entry) return;
  if (entry.node) entry.node.classList.toggle('talking', talking);
  if (entry.listItem) entry.listItem.classList.toggle('talking', talking);
}

/* ---------------- UI: rider dial + list ---------------- */
function enterCallScreen() {
  joinScreen.hidden = true;
  callScreen.hidden = false;
  channelNameLabel.textContent = roomId;
  connStatus.textContent = 'LIVE';
  addRiderNode(selfId, `${selfName} (you)`, true);
  updateCounts();
}

function addRiderNode(id, name, isSelf) {
  let entry = peers.get(id);
  if (entry) return entry;

  const node = document.createElement('div');
  node.className = 'rider-node' + (isSelf ? ' self' : '');
  node.textContent = initials(name);
  node.title = name;
  riderNodes.appendChild(node);

  const li = document.createElement('li');
  li.className = isSelf ? 'self' : '';
  li.innerHTML = `<span class="pip"></span><span>${escapeHtml(name)}</span>`;
  riderList.appendChild(li);

  entry = { id, name, node, listItem: li, pc: null, audioEl: null, analyser: null, rafId: null };
  peers.set(id, entry);
  layoutRiderNodes();
  return entry;
}

function removePeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  if (entry.rafId) cancelAnimationFrame(entry.rafId);
  if (entry.pc) entry.pc.close();
  if (entry.audioEl) entry.audioEl.remove();
  if (entry.node) entry.node.remove();
  if (entry.listItem) entry.listItem.remove();
  peers.delete(id);
  layoutRiderNodes();
}

function layoutRiderNodes() {
  const others = Array.from(peers.values()).filter((p) => p.id !== selfId);
  const radiusPct = 50; // relative to dial box, nodes sit on the outer ring
  const total = others.length;
  others.forEach((entry, i) => {
    const angle = (i / Math.max(total, 1)) * 2 * Math.PI - Math.PI / 2;
    const x = 50 + radiusPct * Math.cos(angle);
    const y = 50 + radiusPct * Math.sin(angle);
    entry.node.style.left = x + '%';
    entry.node.style.top = y + '%';
  });
}

function updateCounts() {
  const total = peers.size;
  const others = total - 1;
  riderCount.textContent = others <= 0
    ? "You're the only one on this channel"
    : `${others} fellow rider${others === 1 ? '' : 's'} on this channel`;
}

function initials(name) {
  return name.replace(/\(you\)/i, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'R';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ---------------- Mute / Leave ---------------- */
talkToggle.addEventListener('click', () => {
  if (!localStream) return;
  muted = !muted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  talkToggle.setAttribute('aria-pressed', String(muted));
  talkToggle.classList.toggle('muted', muted);
  micIconOn.hidden = muted;
  micIconOff.hidden = !muted;
  talkLabel.textContent = muted ? 'MUTED' : 'LIVE';
});

leaveBtn.addEventListener('click', () => {
  leaveChannel();
});

window.addEventListener('beforeunload', () => {
  if (socket) socket.emit('leave-room');
});

function leaveChannel() {
  if (socket) {
    socket.emit('leave-room');
    socket.disconnect();
    socket = null;
  }
  Array.from(peers.keys()).forEach(removePeer);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  riderNodes.innerHTML = '';
  riderList.innerHTML = '';
  audioSinks.innerHTML = '';
  muted = false;
  talkToggle.setAttribute('aria-pressed', 'false');
  talkToggle.classList.remove('muted');
  micIconOn.hidden = false;
  micIconOff.hidden = true;
  talkLabel.textContent = 'LIVE';

  callScreen.hidden = true;
  joinScreen.hidden = false;
  joinBtn.disabled = false;
  joinBtn.innerHTML = 'KEY UP &amp; JOIN';
  roomInput.value = '';
}

/* ---------------- PWA service worker ---------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
