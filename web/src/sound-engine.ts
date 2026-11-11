const MAX_ACTIVE_IMPACTS = 24;
const MIX_REFERENCE_ENERGY = 0.75;

type ActiveImpact = {
  sources: AudioScheduledSourceNode[];
  mixGain: GainNode;
  intensity: number;
  startedAt: number;
};

export class SoundEngine {
  private context: AudioContext | undefined;
  private collisionBus: GainNode | undefined;
  private master: GainNode | undefined;
  private transientBuffer: AudioBuffer | undefined;
  private volume = 0.65;
  private activeImpacts = new Set<ActiveImpact>();

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(this.outputGain(), this.context.currentTime, 0.012);
    }
  }

  async resume(): Promise<void> {
    this.createContext();
    if (this.context?.state === "suspended") await this.context.resume();
  }

  queueImpact(intensity: number): void {
    if (this.volume <= 0 || !this.context || this.context.state !== "running") return;
    this.playImpact(clamp(intensity, 0, 1));
  }

  private createContext(): void {
    if (this.context) return;
    const AudioContextConstructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    this.context = new AudioContextConstructor();
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 6;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.08;
    this.collisionBus = this.context.createGain();
    this.master = this.context.createGain();
    this.master.gain.value = this.outputGain();
    this.transientBuffer = this.createTransientBuffer(this.context);
    // Voices -> collision submix -> peak guard -> user volume -> device.
    // User volume comes last, so it never changes the behavior of the limiter.
    this.collisionBus.connect(compressor).connect(this.master).connect(this.context.destination);
  }

  private playImpact(intensity: number): void {
    if (!this.context || !this.collisionBus || intensity <= 0) return;
    const now = this.context.currentTime;
    if (this.activeImpacts.size >= MAX_ACTIVE_IMPACTS) {
      this.reclaimWeakestImpact(now);
    }

    const duration = 0.082;
    const mixGain = this.context.createGain();
    const sources = this.createMetalResonances(now, intensity, duration, mixGain);
    this.createMetalTransient(now, intensity, mixGain, sources);
    mixGain.connect(this.collisionBus);

    const impact: ActiveImpact = { sources, mixGain, intensity, startedAt: now };
    this.activeImpacts.add(impact);
    this.updateImpactMix(now);
    const finalSource = sources[0];
    if (!finalSource) return;
    finalSource.onended = () => {
      this.activeImpacts.delete(impact);
      this.updateImpactMix(this.context?.currentTime ?? 0);
    };
  }

  private createMetalResonances(now: number, intensity: number, duration: number, mixGain: GainNode): AudioScheduledSourceNode[] {
    if (!this.context) return [];
    // Fixed inharmonic partials make a steel-ball click; impact strength only alters gain.
    const partials = [
      { startHz: 480, endHz: 345, gain: 1, decay: duration },
      { startHz: 1040, endHz: 760, gain: 0.3, decay: 0.052 },
      { startHz: 1730, endHz: 1210, gain: 0.12, decay: 0.03 }
    ];
    return partials.map((partial) => {
      const oscillator = this.context!.createOscillator();
      const envelope = this.context!.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(partial.startHz, now);
      oscillator.frequency.exponentialRampToValueAtTime(partial.endHz, now + partial.decay);
      envelope.gain.setValueAtTime(0.0001, now);
      envelope.gain.exponentialRampToValueAtTime((0.065 + intensity * 0.12) * partial.gain, now + 0.002);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + partial.decay);
      oscillator.connect(envelope).connect(mixGain);
      oscillator.start(now);
      oscillator.stop(now + partial.decay + 0.008);
      return oscillator;
    });
  }

  private createMetalTransient(now: number, intensity: number, mixGain: GainNode, sources: AudioScheduledSourceNode[]): void {
    if (!this.context || !this.transientBuffer) return;
    const transient = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    filter.type = "bandpass";
    filter.frequency.value = 2600;
    filter.Q.value = 0.7;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.025 + intensity * 0.045, now + 0.001);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.014);
    transient.buffer = this.transientBuffer;
    transient.connect(filter).connect(envelope).connect(mixGain);
    transient.start(now);
    sources.push(transient);
  }

  private createTransientBuffer(context: AudioContext): AudioBuffer {
    const length = Math.ceil(context.sampleRate * 0.016);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      const envelope = 1 - index / length;
      samples[index] = (Math.random() * 2 - 1) * envelope * envelope;
    }
    return buffer;
  }

  private reclaimWeakestImpact(now: number): void {
    let weakest: ActiveImpact | undefined;
    for (const impact of this.activeImpacts) {
      if (!weakest || impact.intensity < weakest.intensity || (impact.intensity === weakest.intensity && impact.startedAt < weakest.startedAt)) {
        weakest = impact;
      }
    }
    if (!weakest) return;
    this.activeImpacts.delete(weakest);
    weakest.sources[0]?.stop(now + 0.004);
  }

  private updateImpactMix(now: number): void {
    const energy = [...this.activeImpacts]
      .reduce((sum, impact) => sum + Math.pow(0.35 + impact.intensity * 0.65, 2), 0);
    const normalizedGain = Math.min(1, MIX_REFERENCE_ENERGY / Math.sqrt(Math.max(energy, Number.EPSILON)));
    for (const impact of this.activeImpacts) {
      impact.mixGain.gain.setTargetAtTime(normalizedGain, now, 0.004);
    }
  }

  private outputGain(): number {
    return this.volume <= 0 ? 0.0001 : this.volume * 0.3;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
