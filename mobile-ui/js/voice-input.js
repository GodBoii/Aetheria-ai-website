// js/voice-input.js - Cloud intelligent mic input for mobile/WebView
import { authService } from './auth-service.js';
import { config } from './config.js';

const TARGET_SAMPLE_RATE = 16000;
const MAX_AUDIO_SECONDS = 120;
const MIN_AUDIO_SAMPLES = 2000;
const MIN_RECORDING_MS = 1000;
const SILENCE_AUTO_STOP_MS = 2600;
const CLOUD_MIC_ENDPOINT = `${config.backend.url}/api/mic/transcribe`;

class VoiceInputHandler {
  constructor() {
    this.isListening = false;
    this.isStarting = false;
    this.isProcessing = false;
    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.mediaStream = null;
    this.processor = null;
    this.silentGain = null;
    this.dataArray = null;
    this.animationId = null;
    this.audioChunks = [];
    this.capturedSampleRate = TARGET_SAMPLE_RATE;
    this.recordingStartedAt = 0;
    this.lastSpeechAt = 0;

    this.micButton = document.getElementById('voice-input-btn');
    this.inputField = document.getElementById('floating-input');
    this.waveformContainer = this.micButton?.querySelector('.waveform-container') || null;
    this.waveformBaseHeights = [24, 44, 68, 50, 32];
    this.waveformOffsets = [];
    this.silenceThreshold = 0.012;

    if (!this.micButton || !this.inputField) {
      console.warn('[VoiceInput] Required elements not found');
      return;
    }

    if (!this.isSupported()) {
      console.warn('[VoiceInput] Microphone capture is not supported in this environment');
      this.micButton.title = 'Voice input requires microphone access';
      this.micButton.disabled = true;
      return;
    }

    if (this.waveformContainer) {
      const barCount = this.waveformContainer.querySelectorAll('.waveform-bar').length || this.waveformBaseHeights.length;
      this.waveformOffsets = Array.from({ length: barCount }, () => Math.random() * Math.PI * 2);
      this.resetWaveform();
    }

    this.bindEvents();
    console.log('[VoiceInput] Cloud intelligent mic initialized');
  }

  bindEvents() {
    this.micButton.addEventListener('click', () => {
      if (this.isListening || this.isStarting) {
        this.stopListening();
        return;
      }
      if (this.isProcessing) return;
      this.startListening();
    });
  }

  async startListening() {
    if (this.isListening || this.isStarting || this.isProcessing) return;

    try {
      this.isStarting = true;
      this.isListening = true;
      this.audioChunks = [];
      this.recordingStartedAt = performance.now();
      this.lastSpeechAt = this.recordingStartedAt;
      this.updateButtonState();

      await this.setupAudioCapture();

      if (!this.isListening) {
        this.cleanupAudio();
        return;
      }

      this.isStarting = false;
      this.updateButtonState();
      this.startWaveformAnimation();
      this.triggerHaptic('light');
      console.log('[VoiceInput] Recording started');
    } catch (error) {
      console.error('[VoiceInput] Failed to start recording:', error);
      this.cleanupAudio();
      this.isStarting = false;
      this.isListening = false;
      this.updateButtonState();

      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        this.showNotification('Microphone permission denied. Please allow microphone access.', 'error');
      } else if (error.name === 'NotFoundError') {
        this.showNotification('No microphone found.', 'error');
      } else {
        this.showNotification('Could not start voice input. Please check microphone permissions.', 'error');
      }
    }
  }

  async setupAudioCapture() {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass();
    this.capturedSampleRate = this.audioContext.sampleRate;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.microphone = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;
    this.analyser.smoothingTimeConstant = 0.7;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => this.handleAudioProcess(event);

    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.microphone.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);
  }

  handleAudioProcess(event) {
    if (!this.isListening) return;

    const input = event.inputBuffer.getChannelData(0);
    const chunk = new Float32Array(input.length);
    chunk.set(input);
    this.audioChunks.push(chunk);

    const now = performance.now();
    if (this.isSpeechChunk(chunk)) {
      this.lastSpeechAt = now;
    }

    const elapsedMs = now - this.recordingStartedAt;
    const silenceMs = now - this.lastSpeechAt;
    if (elapsedMs >= MIN_RECORDING_MS && silenceMs >= SILENCE_AUTO_STOP_MS) {
      this.stopListening();
    }

    if (elapsedMs >= MAX_AUDIO_SECONDS * 1000) {
      this.stopListening();
    }
  }

  isSpeechChunk(chunk) {
    let sumSquares = 0;
    let zeroCrossings = 0;
    let previous = chunk[0] || 0;

    for (let i = 0; i < chunk.length; i++) {
      const sample = chunk[i];
      sumSquares += sample * sample;
      if ((previous >= 0 && sample < 0) || (previous < 0 && sample >= 0)) {
        zeroCrossings++;
      }
      previous = sample;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, chunk.length));
    const zcr = zeroCrossings / Math.max(1, chunk.length);
    return rms >= this.silenceThreshold || (rms >= this.silenceThreshold * 0.6 && zcr >= 0.12);
  }

  async stopListening({ processAudio = true } = {}) {
    if (!this.isListening && !this.isStarting) return;

    this.isListening = false;
    this.isStarting = false;
    this.triggerHaptic('light');
    this.stopWaveformAnimation();
    this.cleanupAudio();
    this.updateButtonState();
    console.log('[VoiceInput] Recording stopped');

    if (processAudio) {
      await this.processCapturedAudio();
    }
  }

  cleanupAudio() {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.silentGain) {
      this.silentGain.disconnect();
      this.silentGain = null;
    }
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.microphone) {
      this.microphone.disconnect();
      this.microphone = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.dataArray = null;
  }

  async processCapturedAudio() {
    if (!this.audioChunks.length) {
      this.showNotification('No speech detected', 'warning');
      return;
    }

    this.isProcessing = true;
    this.updateButtonState();

    try {
      const rawAudio = this.flattenAudioChunks(this.audioChunks);
      const durationSeconds = rawAudio.length / Math.max(1, this.capturedSampleRate);

      if (durationSeconds > MAX_AUDIO_SECONDS + 1) {
        throw new Error('Voice input is too long. Please keep it under 2 minutes.');
      }

      const audioBuffer = new AudioBuffer({
        length: rawAudio.length,
        numberOfChannels: 1,
        sampleRate: this.capturedSampleRate
      });
      audioBuffer.copyToChannel(rawAudio, 0);

      const resampledAudio = await this.nativeResample(audioBuffer, TARGET_SAMPLE_RATE);
      let finalAudio = this.normalizeAudio(resampledAudio.slice());
      finalAudio = this.trimSilence(finalAudio, TARGET_SAMPLE_RATE);

      if (finalAudio.length < MIN_AUDIO_SAMPLES) {
        this.showNotification('No speech detected', 'warning');
        return;
      }

      const wavBytes = this.encodeWavPcm16(finalAudio, TARGET_SAMPLE_RATE);
      const base64Audio = this.arrayBufferToBase64(wavBytes.buffer);
      const text = await this.transcribeWithCloudMic(base64Audio);

      if (text) {
        this.appendTextToInput(text);
      } else {
        this.showNotification('Could not hear you clearly. Try speaking closer.', 'warning');
      }
    } catch (error) {
      console.error('[VoiceInput] Failed to process mic audio:', error);
      this.showNotification(error.message || 'Failed to process voice input', 'error');
    } finally {
      this.audioChunks = [];
      this.isProcessing = false;
      this.updateButtonState();
    }
  }

  async transcribeWithCloudMic(base64Audio) {
    const session = await authService.getSession();
    const token = session?.access_token;
    if (!token) {
      throw new Error('Please sign in to use voice input.');
    }

    const response = await fetch(CLOUD_MIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audio: base64Audio,
        format: 'wav',
        language: 'en'
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error || `Voice input failed (${response.status})`);
    }

    return String(payload?.text || payload?.raw_text || '').trim();
  }

  flattenAudioChunks(chunks) {
    const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Float32Array(totalLength);
    let offset = 0;
    chunks.forEach((chunk) => {
      output.set(chunk, offset);
      offset += chunk.length;
    });
    return output;
  }

  async nativeResample(audioBuffer, targetSampleRate) {
    if (audioBuffer.sampleRate === targetSampleRate) {
      return audioBuffer.getChannelData(0);
    }

    const ratio = audioBuffer.sampleRate / targetSampleRate;
    const newLength = Math.max(1, Math.round(audioBuffer.length / ratio));
    const offlineContext = new OfflineAudioContext(1, newLength, targetSampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineContext.destination);
    source.start();
    const renderedBuffer = await offlineContext.startRendering();
    return renderedBuffer.getChannelData(0);
  }

  normalizeAudio(buffer) {
    if (!buffer.length) return buffer;

    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i];
    }
    const mean = sum / buffer.length;

    let max = 0;
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] -= mean;
      max = Math.max(max, Math.abs(buffer[i]));
    }

    if (max === 0) return buffer;

    const scale = 0.95 / max;
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] *= scale;
    }
    return buffer;
  }

  trimSilence(buffer, sampleRate = TARGET_SAMPLE_RATE) {
    if (!buffer?.length) return buffer;

    const frameSize = Math.max(1, Math.floor(sampleRate * 0.015));
    const totalFrames = Math.ceil(buffer.length / frameSize);
    const noiseSamples = Math.min(buffer.length, Math.floor(sampleRate * 0.25));
    let noiseSquares = 0;

    for (let i = 0; i < noiseSamples; i++) {
      noiseSquares += buffer[i] * buffer[i];
    }

    const noiseRms = noiseSamples ? Math.sqrt(noiseSquares / noiseSamples) : 0;
    const energyThreshold = Math.min(0.08, Math.max(noiseRms * 2.5, 0.0035));
    const consonantThreshold = energyThreshold * 0.6;

    let firstSpeechFrame = -1;
    let lastSpeechFrame = -1;

    for (let frame = 0; frame < totalFrames; frame++) {
      const start = frame * frameSize;
      const end = Math.min(buffer.length, start + frameSize);
      let sumSquares = 0;
      let zeroCrossings = 0;
      let previous = buffer[start] || 0;

      for (let i = start; i < end; i++) {
        const sample = buffer[i];
        sumSquares += sample * sample;
        if ((previous >= 0 && sample < 0) || (previous < 0 && sample >= 0)) {
          zeroCrossings++;
        }
        previous = sample;
      }

      const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
      const zcr = zeroCrossings / Math.max(1, end - start);
      const isSpeech = rms >= energyThreshold || (rms >= consonantThreshold && zcr >= 0.12);

      if (isSpeech) {
        if (firstSpeechFrame === -1) firstSpeechFrame = frame;
        lastSpeechFrame = frame;
      }
    }

    if (firstSpeechFrame === -1) return new Float32Array(0);

    const startSample = Math.max(0, firstSpeechFrame * frameSize - Math.floor(sampleRate * 0.3));
    const endSample = Math.min(buffer.length, (lastSpeechFrame + 1) * frameSize + Math.floor(sampleRate * 0.5));
    return buffer.slice(startSample, endSample);
  }

  encodeWavPcm16(samples, sampleRate) {
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    this.writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeAscii(view, 8, 'WAVE');
    this.writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    this.writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    return new Uint8Array(buffer);
  }

  writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    return btoa(binary);
  }

  appendTextToInput(text) {
    const cleanText = text.trim();
    if (!cleanText) return;

    const currentValue = this.inputField.value.trim();
    this.inputField.value = currentValue ? `${currentValue} ${cleanText}` : cleanText;
    this.autoResizeInput();
    this.inputField.dispatchEvent(new Event('input', { bubbles: true }));
    this.inputField.focus();
  }

  updateButtonState() {
    if (!this.micButton) return;

    this.micButton.classList.toggle('listening', this.isListening);
    this.micButton.classList.toggle('idle', !this.isListening && !this.isProcessing);
    this.micButton.classList.toggle('processing', this.isProcessing);
    this.micButton.disabled = this.isProcessing;
  }

  startWaveformAnimation() {
    if (!this.waveformContainer) return;
    const bars = this.waveformContainer.querySelectorAll('.waveform-bar');
    if (!bars.length) return;

    const lastHeights = Array.from(bars).map((_, index) => this.waveformBaseHeights[index % this.waveformBaseHeights.length]);

    const animate = () => {
      if (!this.isListening) {
        this.waveformContainer.classList.add('is-silent');
        return;
      }

      let isSilent = true;

      if (this.analyser && this.dataArray) {
        this.analyser.getByteFrequencyData(this.dataArray);
        const binsPerBar = Math.max(1, Math.floor(this.dataArray.length / bars.length));
        let totalEnergy = 0;

        bars.forEach((bar, index) => {
          const start = index * binsPerBar;
          const end = Math.min(this.dataArray.length, start + binsPerBar);
          let sum = 0;
          for (let i = start; i < end; i++) {
            sum += this.dataArray[i];
          }
          const normalized = (sum / Math.max(1, end - start)) / 255;
          totalEnergy += normalized;
          const base = this.waveformBaseHeights[index % this.waveformBaseHeights.length];
          const target = Math.max(base, Math.min(98, 18 + normalized * 85));
          lastHeights[index] = this.easeHeight(lastHeights[index], target, 0.32);
          this.updateBarScale(bar, lastHeights[index]);
        });

        isSilent = totalEnergy / bars.length < 0.04;
      }

      this.waveformContainer.classList.toggle('is-silent', isSilent);
      this.animationId = requestAnimationFrame(animate);
    };

    animate();
  }

  stopWaveformAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.resetWaveform();
  }

  resetWaveform() {
    if (!this.waveformContainer) return;
    const bars = this.waveformContainer.querySelectorAll('.waveform-bar');
    bars.forEach((bar, index) => {
      this.updateBarScale(bar, this.waveformBaseHeights[index % this.waveformBaseHeights.length]);
    });
    this.waveformContainer.classList.add('is-silent');
  }

  easeHeight(current, target, factor = 0.25) {
    return current + (target - current) * factor;
  }

  updateBarScale(bar, percent) {
    if (!bar) return;
    const clamped = Math.max(5, Math.min(110, percent));
    bar.style.setProperty('--bar-scale', (clamped / 100).toFixed(3));
  }

  autoResizeInput() {
    if (!this.inputField) return;
    requestAnimationFrame(() => {
      this.inputField.style.height = 'auto';
      this.inputField.style.height = `${this.inputField.scrollHeight}px`;
    });
  }

  triggerHaptic(intensity = 'light') {
    if (!navigator.vibrate) return;
    const patterns = { light: 10, medium: 20, heavy: 30 };
    navigator.vibrate(patterns[intensity] || patterns.light);
  }

  isSupported() {
    return Boolean(
      navigator.mediaDevices?.getUserMedia &&
      (window.AudioContext || window.webkitAudioContext) &&
      window.OfflineAudioContext
    );
  }

  showNotification(message, type = 'info') {
    if (window.chat && typeof window.chat.showNotification === 'function') {
      window.chat.showNotification(message, type);
      return;
    }

    console.warn('[VoiceInput]', message);
    const toast = document.createElement('div');
    toast.className = 'voice-input-toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 100px;
      left: 50%;
      transform: translateX(-50%);
      background: ${type === 'warning' ? '#f59e0b' : type === 'error' ? 'var(--error-bg, #ff4444)' : '#2563eb'};
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 10000;
      max-width: 90%;
      text-align: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  destroy() {
    this.stopListening({ processAudio: false });
    this.cleanupAudio();
    this.stopWaveformAnimation();
  }
}

export default VoiceInputHandler;
