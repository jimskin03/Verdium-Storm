import { adEnv, chain, clampFreq, filter, gain, modulate, noiseSource, osc, saturationCurve } from './Synth';

/**
 * EVA — the battlefield announcer.
 *
 * There are no voice files in this project and there never will be, so the
 * callouts are synthesised with a source/filter (formant) vocal model: a stepped
 * glottal pulse train driving a bank of resonant bandpass filters, with noise
 * bursts for the consonants. The result is deliberately not photoreal speech —
 * it is pitch-quantised, ring-modulated and squeezed into a comms band so it
 * reads as a 1990s tactical computer rather than as failed text-to-speech. That
 * is the stylistic choice, and every parameter below leans into it.
 */

/* ------------------------------------------------------------ phonetics */

interface Vowel {
  /** Formant centres in Hz, F1..F3. */
  f: [number, number, number];
  /** Optional glide target for diphthongs. */
  to?: [number, number, number];
}

const VOWELS: Record<string, Vowel> = {
  ee: { f: [270, 2290, 3010] },
  ih: { f: [390, 1990, 2550] },
  eh: { f: [530, 1840, 2480] },
  ae: { f: [660, 1720, 2410] },
  aa: { f: [730, 1090, 2440] },
  uh: { f: [620, 1190, 2390] },
  oh: { f: [570, 840, 2410] },
  oo: { f: [330, 870, 2240] },
  er: { f: [490, 1350, 1690] },
  ay: { f: [530, 1840, 2480], to: [350, 2200, 2700] },
  ow: { f: [730, 1090, 2440], to: [330, 900, 2300] },
};

type ConsonantKind = 'plosive' | 'fricative' | 'nasal' | 'liquid';

interface Consonant {
  kind: ConsonantKind;
  /** Noise band centre for plosive bursts and fricatives. */
  hz: number;
  q: number;
  /** Seconds the articulation occupies. */
  dur: number;
  /** Amplitude of the noise component. */
  level: number;
  /** Voiced consonants keep the glottal source running. */
  voiced?: boolean;
  /** Formant target while the articulation is held (nasals, liquids). */
  f?: [number, number, number];
}

const CONSONANTS: Record<string, Consonant> = {
  p: { kind: 'plosive', hz: 900, q: 1.1, dur: 0.045, level: 0.55 },
  t: { kind: 'plosive', hz: 4000, q: 1.4, dur: 0.042, level: 0.7 },
  k: { kind: 'plosive', hz: 2100, q: 1.2, dur: 0.05, level: 0.7 },
  b: { kind: 'plosive', hz: 700, q: 1.1, dur: 0.04, level: 0.35, voiced: true },
  d: { kind: 'plosive', hz: 3200, q: 1.3, dur: 0.038, level: 0.45, voiced: true },
  g: { kind: 'plosive', hz: 1700, q: 1.2, dur: 0.045, level: 0.45, voiced: true },
  s: { kind: 'fricative', hz: 6200, q: 1.6, dur: 0.085, level: 0.55 },
  z: { kind: 'fricative', hz: 5200, q: 1.6, dur: 0.075, level: 0.35, voiced: true },
  sh: { kind: 'fricative', hz: 3000, q: 1.1, dur: 0.095, level: 0.6 },
  f: { kind: 'fricative', hz: 5200, q: 0.8, dur: 0.075, level: 0.35 },
  v: { kind: 'fricative', hz: 4200, q: 0.8, dur: 0.06, level: 0.22, voiced: true },
  th: { kind: 'fricative', hz: 4600, q: 0.9, dur: 0.07, level: 0.3 },
  h: { kind: 'fricative', hz: 1400, q: 0.6, dur: 0.055, level: 0.28 },
  m: { kind: 'nasal', hz: 280, q: 4, dur: 0.06, level: 0.05, voiced: true, f: [280, 1100, 2400] },
  n: { kind: 'nasal', hz: 320, q: 4, dur: 0.055, level: 0.05, voiced: true, f: [320, 1500, 2600] },
  ng: { kind: 'nasal', hz: 300, q: 4, dur: 0.06, level: 0.05, voiced: true, f: [300, 1200, 2300] },
  l: { kind: 'liquid', hz: 400, q: 3, dur: 0.05, level: 0.04, voiced: true, f: [400, 1100, 2600] },
  r: { kind: 'liquid', hz: 350, q: 3, dur: 0.055, level: 0.04, voiced: true, f: [350, 1000, 1600] },
  w: { kind: 'liquid', hz: 320, q: 3, dur: 0.05, level: 0.03, voiced: true, f: [320, 800, 2300] },
  y: { kind: 'liquid', hz: 300, q: 3, dur: 0.045, level: 0.03, voiced: true, f: [300, 2200, 3000] },
};

/** Longest-first so `sh` never parses as `s` + `h`. */
const CONSONANT_KEYS = Object.keys(CONSONANTS).sort((a, b) => b.length - a.length);
const VOWEL_KEYS = Object.keys(VOWELS).sort((a, b) => b.length - a.length);

interface Syllable {
  onset: string[];
  vowel: string;
  coda: string[];
  stressed: boolean;
  /** Extra pause after this syllable, for word boundaries. */
  gap: number;
}

/**
 * Parses the pronunciation notation used in the phrase table: syllables are
 * separated by `-`, words by a space, and a leading `*` marks stress.
 * `"kuhn-*struhk-shuhn kuhm-pleet"` → 5 syllables with stress on the second.
 */
function parsePhrase(text: string): Syllable[] {
  const out: Syllable[] = [];
  const words = text.trim().split(/\s+/);
  for (let w = 0; w < words.length; w++) {
    const syllables = words[w].split('-');
    for (let i = 0; i < syllables.length; i++) {
      let s = syllables[i];
      const stressed = s.startsWith('*');
      if (stressed) s = s.slice(1);
      const onset: string[] = [];
      const coda: string[] = [];
      let pos = 0;
      let vowel = '';
      // Consonant cluster, then the vowel nucleus, then the coda cluster.
      while (pos < s.length && !vowel) {
        const c = CONSONANT_KEYS.find((k) => s.startsWith(k, pos));
        const v = VOWEL_KEYS.find((k) => s.startsWith(k, pos));
        if (v && (!c || c.length <= v.length)) {
          vowel = v;
          pos += v.length;
        } else if (c) {
          onset.push(c);
          pos += c.length;
        } else {
          pos++;
        }
      }
      while (pos < s.length) {
        const c = CONSONANT_KEYS.find((k) => s.startsWith(k, pos));
        if (!c) break;
        coda.push(c);
        pos += c.length;
      }
      if (!vowel) continue;
      const lastOfWord = i === syllables.length - 1;
      out.push({ onset, vowel, coda, stressed, gap: lastOfWord && w < words.length - 1 ? 0.075 : 0 });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- phrases */

export interface EvaPhrase {
  /** Human readable, for docs and debugging. */
  text: string;
  /** Pronunciation in the notation above. */
  say: string;
  /** Alerts rise in pitch and get a stinger; reports fall away. */
  urgent: boolean;
  /** Base pitch multiplier — small variety between callouts. */
  pitch: number;
}

export const EVA_PHRASES: Record<string, EvaPhrase> = {
  'eva.constructionComplete': {
    text: 'Construction complete', say: 'kuhn-*struhk-shuhn kuhm-*pleet', urgent: false, pitch: 1.0,
  },
  'eva.unitReady': {
    text: 'Unit ready', say: '*yoo-niht *reh-dee', urgent: false, pitch: 1.02,
  },
  'eva.newOptions': {
    text: 'New construction options', say: '*nyoo kuhn-*struhk-shuhn *ohp-shuhnz', urgent: false, pitch: 1.0,
  },
  'eva.insufficientFunds': {
    text: 'Insufficient funds', say: 'ihn-suh-*fih-shuhnt *fuhndz', urgent: false, pitch: 0.98,
  },
  'eva.lowPower': {
    text: 'Low power', say: '*loh *pow-er', urgent: true, pitch: 0.96,
  },
  'eva.baseUnderAttack': {
    text: 'Base under attack', say: '*bays uhn-der uh-*taek', urgent: true, pitch: 1.04,
  },
  'eva.unitLost': {
    text: 'Unit lost', say: '*yoo-niht *lohst', urgent: true, pitch: 0.97,
  },
  'eva.harvesterLost': {
    text: 'Harvester under attack', say: '*haar-veh-ster uhn-der uh-*taek', urgent: true, pitch: 0.99,
  },
};

export const EVA_IDS: string[] = Object.keys(EVA_PHRASES);

/* ------------------------------------------------------------- synthesis */

export interface EvaOptions {
  ctx: BaseAudioContext;
  dest: AudioNode;
  t: number;
  gain: number;
  rng: () => number;
}

/**
 * Builds one utterance. Every parameter change is scheduled up front, so the
 * whole callout is deterministic once triggered and renders identically in an
 * OfflineAudioContext.
 *
 * @returns the length of the utterance in seconds.
 */
export function speak(id: string, o: EvaOptions): number {
  const phrase = EVA_PHRASES[id];
  if (!phrase) return 0;
  const { ctx, rng } = o;
  const syllables = parsePhrase(phrase.say);
  if (syllables.length === 0) return 0;

  const out = gain(ctx, 0);

  // ---- comms channel: band limit, drive, and a short comb for the metal ----
  const hp = filter(ctx, 'highpass', 280, 0.8);
  const lp = filter(ctx, 'lowpass', 3600, 0.9);
  const drive = ctx.createWaveShaper();
  drive.curve = saturationCurve(0.22);
  const preComb = gain(ctx, 1);
  chain(out, hp, lp, drive, preComb);

  // Ring modulation at a low audio rate is what makes it read as "machine".
  const ring = gain(ctx, 0.82);
  const ringOsc = osc(ctx, 'sine', 47 * phrase.pitch);
  const ringDepth = gain(ctx, 0.18);
  modulate(ringOsc, ringDepth, ring.gain);
  preComb.connect(ring);

  // Parallel comb: a 6 ms feedback delay, i.e. a resonance at ~165 Hz.
  const comb = ctx.createDelay(0.05);
  comb.delayTime.value = 0.0061;
  const combFb = gain(ctx, 0.42);
  const combMix = gain(ctx, 0.3);
  const combDamp = filter(ctx, 'lowpass', 2600, 0.7);
  ring.connect(comb);
  chain(comb, combDamp, combFb);
  combFb.connect(comb);
  chain(combDamp, combMix);
  ring.connect(o.dest);
  combMix.connect(o.dest);

  // ---- source: stepped glottal pulse train -------------------------------
  const f0 = 116 * phrase.pitch;
  const voiced = gain(ctx, 0);
  const glottal: OscillatorNode[] = [];
  for (const detune of [-7, 6]) {
    const g1 = osc(ctx, 'sawtooth', f0, detune);
    const gg = gain(ctx, 0.5);
    chain(g1, gg, voiced);
    glottal.push(g1);
  }
  // A square an octave down adds the buzzy sub that sells the vocoder timbre.
  const sub = osc(ctx, 'square', f0 * 0.5);
  const subGain = gain(ctx, 0.12);
  chain(sub, subGain, voiced);
  glottal.push(sub);

  // ---- formant bank -------------------------------------------------------
  const formantGains = [1.0, 0.55, 0.3];
  const formants: BiquadFilterNode[] = [];
  const bandwidths = [80, 110, 170];
  for (let i = 0; i < 3; i++) {
    const bp = filter(ctx, 'bandpass', VOWELS.uh.f[i], VOWELS.uh.f[i] / bandwidths[i]);
    const fg = gain(ctx, formantGains[i]);
    voiced.connect(bp);
    chain(bp, fg, out);
    formants.push(bp);
  }
  // A fixed high formant keeps the voice present in a busy mix.
  const presence = filter(ctx, 'bandpass', 3300, 8);
  const presenceGain = gain(ctx, 0.12);
  voiced.connect(presence);
  chain(presence, presenceGain, out);

  // ---- consonant noise chain ---------------------------------------------
  const noise = noiseSource(ctx, { kind: 'white', seed: 3 });
  const noiseBp = filter(ctx, 'bandpass', 4000, 1.2);
  const noiseGain = gain(ctx, 0);
  chain(noise, noiseBp, noiseGain, out);

  // ---- schedule ------------------------------------------------------------
  let t = o.t + 0.02;
  const level = o.gain;
  const semitone = (n: number): number => Math.pow(2, n / 12);
  const setFormants = (target: readonly [number, number, number], at: number, glide: number): void => {
    for (let i = 0; i < 3; i++) {
      const f = clampFreq(ctx, target[i]);
      formants[i].frequency.setTargetAtTime(f, at, Math.max(glide, 0.005) / 3);
      formants[i].Q.setTargetAtTime(Math.max(1.5, f / bandwidths[i]), at, 0.02);
    }
  };

  for (let i = 0; i < syllables.length; i++) {
    const syl = syllables[i];
    const progress = i / Math.max(1, syllables.length - 1);
    // Pitch is quantised to semitones and steps between syllables — no glissando.
    const contour = phrase.urgent ? Math.round(progress * 3) : -Math.round(progress * 2);
    const step = contour + (syl.stressed ? 2 : 0);
    const f = f0 * semitone(step);
    for (const g1 of glottal) {
      g1.frequency.setValueAtTime(clampFreq(ctx, g1 === sub ? f * 0.5 : f), t);
    }

    // --- onset consonants
    for (const c of syl.onset) {
      const cons = CONSONANTS[c];
      if (cons.kind === 'plosive') {
        // Closure, then release burst.
        voiced.gain.setValueAtTime(0, t);
        t += cons.dur * 0.55;
        noiseBp.frequency.setValueAtTime(clampFreq(ctx, cons.hz), t);
        noiseBp.Q.setValueAtTime(cons.q, t);
        adEnv(noiseGain.gain, t, level * cons.level, 0.001, 0.022);
        if (cons.voiced) voiced.gain.setTargetAtTime(level * 0.35, t + 0.01, 0.01);
        t += cons.dur * 0.45;
      } else if (cons.kind === 'fricative') {
        noiseBp.frequency.setValueAtTime(clampFreq(ctx, cons.hz), t);
        noiseBp.Q.setValueAtTime(cons.q, t);
        adEnv(noiseGain.gain, t, level * cons.level, 0.02, cons.dur);
        if (cons.voiced) voiced.gain.setTargetAtTime(level * 0.3, t, 0.02);
        else voiced.gain.setValueAtTime(0, t);
        t += cons.dur;
      } else {
        // Nasals and liquids are voiced with their own formant shape.
        setFormants(cons.f ?? VOWELS.uh.f, t, 0.02);
        voiced.gain.setTargetAtTime(level * 0.5, t, 0.012);
        t += cons.dur;
      }
    }

    // --- vowel nucleus
    const vowel = VOWELS[syl.vowel] ?? VOWELS.uh;
    const dur = (syl.stressed ? 0.155 : 0.115) * (0.92 + rng() * 0.16);
    setFormants(vowel.f, t, 0.03);
    voiced.gain.setTargetAtTime(level * (syl.stressed ? 1.0 : 0.78), t, 0.015);
    if (vowel.to) setFormants(vowel.to, t + dur * 0.45, dur * 0.5);
    t += dur;

    // --- coda consonants
    for (const c of syl.coda) {
      const cons = CONSONANTS[c];
      if (cons.kind === 'plosive') {
        voiced.gain.setTargetAtTime(0, t, 0.008);
        t += cons.dur * 0.6;
        noiseBp.frequency.setValueAtTime(clampFreq(ctx, cons.hz), t);
        noiseBp.Q.setValueAtTime(cons.q, t);
        adEnv(noiseGain.gain, t, level * cons.level * 0.7, 0.001, 0.02);
        t += cons.dur * 0.4;
      } else if (cons.kind === 'fricative') {
        voiced.gain.setTargetAtTime(cons.voiced ? level * 0.25 : 0, t, 0.01);
        noiseBp.frequency.setValueAtTime(clampFreq(ctx, cons.hz), t);
        noiseBp.Q.setValueAtTime(cons.q, t);
        adEnv(noiseGain.gain, t, level * cons.level * 0.8, 0.015, cons.dur);
        t += cons.dur;
      } else {
        setFormants(cons.f ?? VOWELS.uh.f, t, 0.02);
        voiced.gain.setTargetAtTime(level * 0.45, t, 0.012);
        t += cons.dur;
      }
    }

    if (syl.gap > 0) {
      voiced.gain.setTargetAtTime(0, t, 0.01);
      t += syl.gap;
    }
  }

  // Release.
  voiced.gain.setTargetAtTime(0, t, 0.03);
  const end = t + 0.18;
  out.gain.setValueAtTime(1, o.t);
  out.gain.setValueAtTime(1, end - 0.05);
  out.gain.linearRampToValueAtTime(0, end);

  const stopAt = end + 0.25;
  for (const g1 of glottal) {
    g1.start(o.t);
    g1.stop(stopAt);
  }
  noise.start(o.t, rng() * 1.5);
  noise.stop(stopAt);
  ringOsc.start(o.t);
  ringOsc.stop(stopAt);

  return end - o.t;
}
