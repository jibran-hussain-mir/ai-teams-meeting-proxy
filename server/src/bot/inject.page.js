// Runs inside the meeting page before any site script (Playwright addInitScript).
// Plain browser JavaScript on purpose: it is read from disk and injected verbatim.
//
// Speaking:  getUserMedia is overridden so the "microphone" is a WebAudio node
//            that the server feeds with TTS audio through window.__abPlay().
// Listening: every remote WebRTC audio track is mixed, downsampled to 16 kHz
//            mono PCM16 and handed to the server through window.__abAudioIn().
(() => {
  if (window.__abInstalled) return;
  window.__abInstalled = true;

  const OUT_RATE = 16000;
  let ctx = null;
  let micDest = null; // what the meeting hears
  let captureMix = null; // what the server hears
  let playHead = 0;
  const liveSources = new Set();

  function ensureCtx() {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 48000 });
      micDest = ctx.createMediaStreamDestination();

      // A silent constant source keeps the mic track producing frames.
      const keepAlive = ctx.createConstantSource();
      const zero = ctx.createGain();
      zero.gain.value = 0;
      keepAlive.connect(zero).connect(micDest);
      keepAlive.start();

      captureMix = ctx.createGain();
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      captureMix.connect(proc);
      proc.connect(mute).connect(ctx.destination);
      const ratio = ctx.sampleRate / OUT_RATE;
      proc.onaudioprocess = (e) => {
        if (typeof window.__abAudioIn !== 'function') return;
        const input = e.inputBuffer.getChannelData(0);
        const outLen = Math.floor(input.length / ratio);
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const start = Math.floor(i * ratio);
          const end = Math.min(input.length, Math.floor((i + 1) * ratio));
          let sum = 0;
          for (let j = start; j < end; j++) sum += input[j];
          const s = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        window.__abAudioIn(bytesToBase64(new Uint8Array(pcm.buffer)));
      };
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ---- Speaking -----------------------------------------------------------

  // The "camera" is a plain black picture. Without this the browser's built-in
  // test camera shows a bright green pattern in the preview on the join screen.
  let blackCanvas = null;
  function blackVideoTrack() {
    if (!blackCanvas) {
      blackCanvas = document.createElement('canvas');
      blackCanvas.width = 640;
      blackCanvas.height = 360;
      const paint = () => {
        const g = blackCanvas.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, blackCanvas.width, blackCanvas.height);
      };
      paint();
      // A canvas only sends a frame when it is drawn on.
      setInterval(paint, 1000);
    }
    return blackCanvas.captureStream(5).getVideoTracks()[0];
  }

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const origGUM = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      if (!constraints || (!constraints.audio && !constraints.video)) return origGUM(constraints);
      const stream = new MediaStream();
      if (constraints.audio) {
        ensureCtx();
        for (const t of micDest.stream.getAudioTracks()) stream.addTrack(t.clone());
      }
      if (constraints.video) {
        try {
          stream.addTrack(blackVideoTrack());
        } catch (_) {
          // No picture at all is fine too: the assistant never shows video.
        }
      }
      return stream;
    };
  }

  // For the server: is the audio engine actually running?
  window.__abClock = () => (ctx ? ctx.currentTime : -1);

  // Queue PCM16 mono audio (base64) to be spoken into the meeting.
  window.__abPlay = (b64, sampleRate) => {
    const c = ensureCtx();
    const bytes = base64ToBytes(b64);
    const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
    if (pcm.length === 0) return 0;
    const buf = c.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(micDest);
    const at = Math.max(playHead, c.currentTime + 0.03);
    src.start(at);
    playHead = at + buf.duration;
    liveSources.add(src);
    src.onended = () => liveSources.delete(src);
    return playHead - c.currentTime; // seconds of audio still queued
  };

  // Cut speech off immediately (barge-in or kill switch).
  window.__abStop = () => {
    for (const s of liveSources) {
      try {
        s.stop();
      } catch (_) {}
    }
    liveSources.clear();
    playHead = 0;
  };

  // Seconds of speech still queued; 0 when silent.
  window.__abQueued = () => (ctx ? Math.max(0, playHead - ctx.currentTime) : 0);

  // ---- Listening ----------------------------------------------------------

  const seenTracks = new WeakSet();
  const keepElements = [];

  function attachRemoteTrack(track) {
    if (track.kind !== 'audio' || seenTracks.has(track)) return;
    seenTracks.add(track);
    try {
      ensureCtx();
      const stream = new MediaStream([track]);
      // Chromium only delivers remote WebRTC audio to WebAudio while the
      // stream is also attached to a media element.
      const el = new Audio();
      el.muted = true;
      el.srcObject = stream;
      el.play().catch(() => {});
      keepElements.push(el);
      ctx.createMediaStreamSource(stream).connect(captureMix);
      window.__abTrackCount = (window.__abTrackCount || 0) + 1;
    } catch (err) {
      console.warn('[proxy] could not capture remote track', err);
    }
  }

  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    const PatchedPC = function (...args) {
      const pc = new OrigPC(...args);
      pc.addEventListener('track', (e) => attachRemoteTrack(e.track));
      return pc;
    };
    PatchedPC.prototype = OrigPC.prototype;
    Object.setPrototypeOf(PatchedPC, OrigPC);
    window.RTCPeerConnection = PatchedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedPC;
  }
})();
