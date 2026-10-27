export class AudioTools {
  #stream = null;
  #context = null;
  #timer = null;
  #animation = null;
  #generation = 0;
  #active = false;

  constructor({ onMeter = () => {}, onState = () => {} } = {}) {
    this.onMeter = onMeter;
    this.onState = onState;
  }

  get active() { return this.#active; }

  stop() {
    this.#generation++;
    clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#animation !== null) cancelAnimationFrame(this.#animation);
    this.#animation = null;
    this.#stream?.getTracks().forEach(track => track.stop());
    this.#stream = null;
    if (this.#context) void this.#context.close().catch(() => {});
    this.#context = null;
    this.#active = false;
    this.onMeter(0);
    this.onState('idle');
  }

  async microphone() {
    this.stop();
    const generation = this.#generation;
    this.#active = true;
    this.onState('requesting');
    // This timer also invalidates an unanswered permission request. A late stream
    // is immediately stopped; browsers do not provide a getUserMedia abort API.
    this.#timer = setTimeout(() => this.stop(), 30_000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (generation !== this.#generation) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.#stream = stream;
      for (const track of stream.getTracks()) track.addEventListener('ended', () => this.stop(), { once: true });
      this.#context = new AudioContext();
      const source = this.#context.createMediaStreamSource(stream);
      const analyser = this.#context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      // Deliberately never connect microphone audio to speakers or a recorder.
      await this.#context.resume();
      if (generation !== this.#generation) return;
      const label = stream.getAudioTracks()[0]?.label || 'Browser-selected microphone';
      this.onState('microphone', label);
      const samples = new Uint8Array(analyser.fftSize);
      const update = () => {
        if (generation !== this.#generation) return;
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length);
        this.onMeter(Math.min(100, rms * 300));
        this.#animation = requestAnimationFrame(update);
      };
      update();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.stop();
      throw error;
    }
  }

  async tone() {
    this.stop();
    const generation = this.#generation;
    this.#active = true;
    this.onState('tone');
    this.#timer = setTimeout(() => this.stop(), 5_000);
    try {
      this.#context = new AudioContext();
      const oscillator = this.#context.createOscillator();
      const gain = this.#context.createGain();
      gain.gain.value = 0.025;
      oscillator.frequency.value = 220;
      oscillator.connect(gain);
      gain.connect(this.#context.destination);
      oscillator.start();
      await this.#context.resume();
      if (generation !== this.#generation) return;
    } catch (error) {
      if (generation !== this.#generation) return;
      this.stop();
      throw error;
    }
  }
}
