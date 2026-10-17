// Alarm sounds, synthesised with the Web Audio API (no audio files to load or
// fail). The window is created with autoplay allowed and background throttling
// off, so alarms play even when the app is hidden in the tray.

let ctx = null;

function context() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/** Call on first user interaction as a belt-and-braces unlock. */
export function unlockAudio() {
  try {
    const c = context();
    if (c.state === 'suspended') c.resume();
  } catch (_) { /* audio unavailable */ }
}

function envelope(c, gainNode, t, attack, peak, decay) {
  gainNode.gain.setValueAtTime(0.0001, t);
  gainNode.gain.exponentialRampToValueAtTime(peak, t + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(c, out, { freq, type = 'sine', at, attack = 0.01, decay = 0.8, peak = 0.5, detune = 0 }) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.detune.value = detune;
  envelope(c, g, at, attack, peak, decay);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + attack + decay + 0.05);
}

const SOUNDS = {
  // three rising notes, played twice
  chime(c, out, t) {
    const notes = [659.25, 830.61, 987.77];
    for (let r = 0; r < 2; r += 1) {
      notes.forEach((f, i) => tone(c, out, { freq: f, at: t + r * 1.1 + i * 0.16, decay: 0.9, peak: 0.35 }));
    }
    return 2.4;
  },
  // inharmonic partials of a small bell, struck three times
  bell(c, out, t) {
    const partials = [[1, 0.5], [2.76, 0.22], [5.4, 0.1], [8.93, 0.05]];
    for (let r = 0; r < 3; r += 1) {
      for (const [ratio, amp] of partials) {
        tone(c, out, { freq: 523.25 * ratio, at: t + r * 0.9, attack: 0.004, decay: 1.6 / Math.sqrt(ratio), peak: amp });
      }
    }
    return 3.4;
  },
  // classic watch beeps: 4 x 2
  digital(c, out, t) {
    for (let r = 0; r < 3; r += 1) {
      for (let i = 0; i < 4; i += 1) {
        tone(c, out, { freq: 2093, type: 'square', at: t + r * 0.9 + i * 0.12, attack: 0.003, decay: 0.07, peak: 0.12 });
      }
    }
    return 2.8;
  },
  // soft swelling pulses
  pulse(c, out, t) {
    for (let i = 0; i < 4; i += 1) {
      tone(c, out, { freq: 392, type: 'triangle', at: t + i * 0.55, attack: 0.18, decay: 0.35, peak: 0.45 });
      tone(c, out, { freq: 587.33, type: 'sine', at: t + i * 0.55, attack: 0.18, decay: 0.35, peak: 0.2 });
    }
    return 2.6;
  },
};

/**
 * Plays an alarm. Resolves with true if playback started.
 * @param {{sound:string, volume:number}} opts volume 0..100
 */
export async function playAlarm({ sound = 'chime', volume = 70 } = {}) {
  try {
    const c = context();
    if (c.state === 'suspended') await c.resume();
    const master = c.createGain();
    const v = Math.max(0, Math.min(100, volume)) / 100;
    master.gain.value = v * v; // perceptual curve
    const comp = c.createDynamicsCompressor();
    master.connect(comp).connect(c.destination);
    const fn = SOUNDS[sound] || SOUNDS.chime;
    fn(c, master, c.currentTime + 0.05);
    return c.state === 'running';
  } catch (err) {
    console.error('Alarm failed', err);
    return false;
  }
}
