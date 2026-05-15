import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mic, Volume2, Check } from 'lucide-react';

interface AudioDevice {
  deviceId: string;
  label: string;
}

export default function Settings() {
  const navigate = useNavigate();
  const [mics, setMics] = useState<AudioDevice[]>([]);
  const [speakers, setSpeakers] = useState<AudioDevice[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>(
    localStorage.getItem('ace_mic') || 'default'
  );
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>(
    localStorage.getItem('ace_speaker') || 'default'
  );
  const [error, setError] = useState<string | null>(null);
  const [supportsSinkId, setSupportsSinkId] = useState(false);

  useEffect(() => {
    setSupportsSinkId('setSinkId' in HTMLMediaElement.prototype);

    // Ask for permission so device labels are populated.
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((devices) => {
        setMics(
          devices
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
        );
        setSpeakers(
          devices
            .filter((d) => d.kind === 'audiooutput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Speaker' }))
        );
      })
      .catch((e) => setError(e?.message ?? 'Mic access denied'));
  }, []);

  function saveMic(id: string) {
    setSelectedMic(id);
    localStorage.setItem('ace_mic', id);
  }

  function saveSpeaker(id: string) {
    setSelectedSpeaker(id);
    localStorage.setItem('ace_speaker', id);
    const audioEl = document.getElementById('ace-remote-audio') as HTMLAudioElement | null;
    if (audioEl && 'setSinkId' in audioEl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (audioEl as any).setSinkId(id).catch((e: Error) => setError(e.message));
    }
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <button onClick={() => navigate(-1)} className="settings-back" aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <h1>Settings</h1>
        <span />
      </div>

      {error && <div className="error" style={{ marginBottom: '1rem' }}>{error}</div>}

      <section className="settings-group">
        <h2><Mic size={18} /> Microphone</h2>
        <div className="device-list">
          {mics.length === 0 && <p className="muted">No microphones found.</p>}
          {mics.map((m) => (
            <button
              key={m.deviceId}
              type="button"
              className={`device-row ${selectedMic === m.deviceId ? 'selected' : ''}`}
              onClick={() => saveMic(m.deviceId)}
            >
              <span className="device-label">{m.label}</span>
              {selectedMic === m.deviceId && <Check size={18} />}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h2><Volume2 size={18} /> Speaker</h2>
        {!supportsSinkId && (
          <p className="muted small">Speaker selection not supported in this browser. Uses system default.</p>
        )}
        <div className="device-list">
          {speakers.length === 0 && <p className="muted">No speakers found.</p>}
          {speakers.map((s) => (
            <button
              key={s.deviceId}
              type="button"
              className={`device-row ${selectedSpeaker === s.deviceId ? 'selected' : ''}`}
              onClick={() => saveSpeaker(s.deviceId)}
              disabled={!supportsSinkId}
            >
              <span className="device-label">{s.label}</span>
              {selectedSpeaker === s.deviceId && <Check size={18} />}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
