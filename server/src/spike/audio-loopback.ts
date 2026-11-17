// Proves the audio bridge works on this machine without Teams:
// a tone is "spoken" into the fake microphone, travels over a real WebRTC
// connection between two peers in one page, and must come back out of the
// remote-track capture at the same pitch.
import { launchAudioPage, CAPTURE_SAMPLE_RATE } from '../bot/browser.js';

const PAGE_URL = 'http://localhost:9/loopback';
const PAGE_HTML = `<!doctype html><title>loopback</title><script>
window.connect = async () => {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  mic.getTracks().forEach((t) => a.addTrack(t, mic));
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);
  await new Promise((resolve) => {
    const check = () => (a.connectionState === 'connected' ? resolve() : setTimeout(check, 50));
    check();
  });
};
</script>`;

function tone(freq: number, seconds: number, sampleRate: number): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5 * 0x7fff), i * 2);
  }
  return buf;
}

function analyse(pcm: Buffer) {
  const n = Math.floor(pcm.length / 2);
  let sumSq = 0;
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 0x8000;
    sumSq += s * s;
    if (i > 0 && prev < 0 !== s < 0) crossings++;
    prev = s;
  }
  return { rms: Math.sqrt(sumSq / Math.max(1, n)), freq: (crossings / 2) * (CAPTURE_SAMPLE_RATE / Math.max(1, n)) };
}

const FREQ = 440;
const frames: Buffer[] = [];
let recording = false;

const bot = await launchAudioPage({
  headless: process.env.HEADLESS !== '0',
  onAudio: (pcm) => recording && frames.push(pcm),
});

let ok = false;
try {
  await bot.page.route(PAGE_URL, (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await bot.page.goto(PAGE_URL);
  await bot.page.evaluate(() => (window as any).connect());
  console.log('WebRTC peers connected');

  // Silence first: nothing should be heard.
  recording = true;
  await bot.page.waitForTimeout(1000);
  const silence = analyse(Buffer.concat(frames));
  frames.length = 0;

  // Speak a 2 s tone in 100 ms chunks, the way TTS audio will arrive.
  const audio = tone(FREQ, 2, 24000);
  const chunk = 24000 * 2 * 0.1;
  for (let off = 0; off < audio.length; off += chunk) {
    await bot.play(audio.subarray(off, off + chunk), 24000);
  }
  await bot.page.waitForTimeout(1500);
  const heard = analyse(Buffer.concat(frames).subarray(CAPTURE_SAMPLE_RATE * 2 * 0.5, CAPTURE_SAMPLE_RATE * 2 * 1.5));
  frames.length = 0;

  // Barge-in: queue 3 s, cut it off, and expect silence afterwards.
  await bot.play(tone(FREQ, 3, 24000), 24000);
  await bot.page.waitForTimeout(500);
  await bot.stopSpeaking();
  await bot.page.waitForTimeout(700);
  frames.length = 0;
  await bot.page.waitForTimeout(1000);
  const afterStop = analyse(Buffer.concat(frames));

  console.log(`silence    rms=${silence.rms.toFixed(4)}`);
  console.log(`tone       rms=${heard.rms.toFixed(4)} freq=${heard.freq.toFixed(0)} Hz (sent ${FREQ} Hz)`);
  console.log(`after stop rms=${afterStop.rms.toFixed(4)}`);

  const checks = {
    'silent before speaking': silence.rms < 0.01,
    'tone captured': heard.rms > 0.05,
    'pitch preserved': Math.abs(heard.freq - FREQ) < 25,
    'stop cuts speech': afterStop.rms < 0.01,
  };
  for (const [name, pass] of Object.entries(checks)) console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  ok = Object.values(checks).every(Boolean);
} finally {
  await bot.close();
}
process.exit(ok ? 0 : 1);
