import { useEffect, useRef, useState } from 'react';
import { api, type Setup } from '../lib/api';
import { Callout, Card, Icon, PageHeader } from '../ui';

const SCRIPT = `Thanks everyone, here's where things stand on my side. Last week went mostly to plan, with a couple of surprises I'll come back to. The main piece of work is finished and has been running without problems since Tuesday. Numbers look better than we expected, which is a nice change. There's one open question I still need help with, so if anyone has ten minutes after this call, let me know. Next week I'm picking up the follow-on work, and I'd guess it takes about five days. If something changes I'll post in the channel straight away. That's everything from me. Happy to take questions now or later, whichever is easier.`;

interface Sample {
  blob: Blob;
  name: string;
  url: string;
}

export function VoiceSetup({ setup, onChange }: { setup: Setup | null; onChange: () => void }) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [testText, setTestText] = useState('');
  const [testUrl, setTestUrl] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!recording) return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  const hasVoice = Boolean(setup?.hasVoice);
  const testMax = setup?.limits?.voiceTestMaxChars ?? 120;
  const addSample = (blob: Blob, name: string) =>
    setSamples((s) => [...s, { blob, name, url: URL.createObjectURL(blob) }]);

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = rec.mimeType || 'audio/webm';
        addSample(new Blob(chunks, { type }), `recording-${Date.now()}.${type.includes('mp4') ? 'm4a' : 'webm'}`);
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      setError('Could not use the microphone. Allow access in the browser, or upload a recording instead.');
    }
  }

  function stopRecording() {
    recorder.current?.stop();
    setRecording(false);
  }

  async function create() {
    setBusy('create');
    setError('');
    try {
      await api.createVoice(samples);
      setDone(true);
      setSamples([]);
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy('');
  }

  async function test() {
    setBusy('test');
    setError('');
    try {
      setTestUrl(URL.createObjectURL(await api.testVoice(testText)));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy('');
  }

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  const recordSteps = (
    <>
      <Card className="step-card">
        <header className="card-head">
          <h2>
            <span className="step-no">1</span> Record a sample
          </h2>
          {recording && (
            <span className="tag rec">
              <span className="dot" /> {clock}
            </span>
          )}
        </header>
        <p className="muted">Read this aloud in your normal meeting voice, in a quiet room.</p>
        <blockquote>{SCRIPT}</blockquote>
        <div className="row">
          {recording ? (
            <button className="danger" onClick={stopRecording}>
              <span className="dot" /> Stop recording
            </button>
          ) : (
            <button className="primary" onClick={() => void startRecording()}>
              <Icon name="mic" /> Start recording
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            multiple
            hidden
            onChange={(e) => {
              for (const f of Array.from(e.target.files ?? [])) addSample(f, f.name);
              e.target.value = '';
            }}
          />
          <button className="secondary" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={16} /> Upload audio
          </button>
        </div>
        {samples.length > 0 && (
          <ul className="samples">
            {samples.map((s, i) => (
              <li key={s.url}>
                <audio controls src={s.url} />
                <button
                  className="ghost"
                  aria-label="Remove sample"
                  onClick={() => setSamples((all) => all.filter((_, j) => j !== i))}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="step-card">
        <header className="card-head">
          <h2>
            <span className="step-no">2</span> Create the voice
          </h2>
        </header>
        <p className="muted">Your samples are sent to ElevenLabs, which builds the clone in a few seconds.</p>
        <button
          className="primary"
          disabled={samples.length === 0 || recording || busy !== ''}
          onClick={() => void create()}
        >
          {busy === 'create' ? 'Creating…' : hasVoice ? 'Replace my voice' : 'Create my voice'}
        </button>
        {done && <Callout kind="ok">Voice created and saved.</Callout>}
      </Card>
    </>
  );

  return (
    <>
      <PageHeader
        eyebrow="Voice"
        title="Your voice"
        subtitle={
          hasVoice
            ? 'The assistant speaks with your cloned voice.'
            : 'Record one to two minutes of yourself so the assistant can speak in your voice.'
        }
      />
      {error && <Callout kind="error">{error}</Callout>}

      <div className="split">
        <div className="stack">
          {hasVoice && (
            <Card className="voice-ready">
              <span className="voice-badge">
                <Icon name="check" size={20} />
              </span>
              <div>
                <h2 className="plain">Voice connected</h2>
                <p className="muted small">Your ElevenLabs voice is linked and ready for meetings.</p>
              </div>
            </Card>
          )}

          <Card title="Test it" icon="wave" className={hasVoice ? '' : 'disabled'}>
            <div className="row">
              <input
                placeholder={`Hi, this is ${setup?.ownerName ?? 'your'}'s AI assistant.`}
                value={testText}
                maxLength={testMax}
                onChange={(e) => setTestText(e.target.value)}
                disabled={!hasVoice}
              />
              <button className="primary" disabled={!hasVoice || busy !== ''} onClick={() => void test()}>
                {busy === 'test' ? 'Generating…' : 'Speak'}
              </button>
            </div>
            <p className="field-hint">
              {hasVoice
                ? `Each test uses ElevenLabs credits, so it is limited to ${testMax} characters.`
                : 'Available once a voice is set up.'}
            </p>
            {testUrl && <audio controls autoPlay src={testUrl} />}
          </Card>

          {hasVoice ? (
            <details className="disclosure">
              <summary>
                <Icon name="chevron" size={16} /> Record a new voice to replace this one
              </summary>
              <div className="stack">{recordSteps}</div>
            </details>
          ) : (
            recordSteps
          )}
        </div>

        <aside className="side">
          <Card title="Already cloned on ElevenLabs?" icon="link">
            <p className="muted small">
              Copy the Voice ID from your ElevenLabs voice and set <code>ELEVENLABS_VOICE_ID</code> in{' '}
              <code>.env</code>, then restart. No need to record again.
            </p>
          </Card>
          <Card title="Tips for a good clone" icon="info">
            <ul className="tips">
              <li>Use the microphone you normally use in meetings.</li>
              <li>No background noise, music or other voices.</li>
              <li>Speak at your usual pace; do not perform.</li>
              <li>One to two minutes is enough. More than three adds little.</li>
            </ul>
          </Card>
          <Card title="Consent" icon="shield">
            <p className="muted small">
              Only clone your own voice. In meetings the assistant always introduces itself as an AI speaking on your
              behalf.
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
