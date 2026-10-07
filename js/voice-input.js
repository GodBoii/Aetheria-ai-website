// js/voice-input.js - Cloud intelligent mic handler for mobile/WebView

import { config } from './config.js';
import { supabase } from './supabase-client.js';
import BrowserDictationController from './browser-dictation.js';
import { mountThinkingOrb } from './thinking-orb.js';

const CLOUD_MIC_ENDPOINT = `${config.backend.url}/api/mic/transcribe`;
const TARGET_SAMPLE_RATE = 16000;
const MAX_AUDIO_SECONDS = 120;
const MIN_AUDIO_SECONDS = 0.35;
const SILENCE_AUTO_STOP_MS = 2600;
const MIN_RECORDING_BEFORE_SILENCE_MS = 900;

class VoiceInputHandler {
  constructor() {
    this.isListening = false;
    this.isProcessing = false;
    this.isStopping = false;
    this.mediaRecorder = null;
    this.currentMimeType = '';
    this.audioChunks = [];
    this.startedAt = 0;
    this.recordingGeneration = 0;
    this.transcriptionController = null;

    this.audioContext = null;
    this.analyser = null;
    this.microphone = null;
    this.mediaStream = null;
    this.dataArray = null;
    this.animationId = null;

    this.micButton = document.getElementById('send-message');
    this.dictationButton = document.getElementById('voice-input-btn');
    this.inputField = document.getElementById('floating-input');
    this.voiceStateSwap = this.micButton?.querySelector('.smart-voice-state-swap') || null;
    this.composingOrbMount = this.micButton?.querySelector('.smart-composing-orb') || null;
    this.composingOrb = null;
    this.lastSoundDetectedAt = 0;
    this.hasDetectedSpeech = false;
    this.silenceThreshold = 0.025;

    if (!this.micButton || !this.dictationButton || !this.inputField) {
      console.warn('[VoiceInput] Required elements not found');
      return;
    }

    this.dictation = new BrowserDictationController({
      button: this.dictationButton,
      input: this.inputField,
      onStateChange: () => this.updateButtonState(),
      notify: (message) => this.showNotification(message),
    });

    if (this.composingOrbMount) {
      this.composingOrb = mountThinkingOrb(this.composingOrbMount, {
        state: 'composing',
        size: 64,
        displaySize: 37,
        speed: 1,
        paused: true,
        ariaLabel: 'Composing intelligent voice',
      });
    }

    if (!this.isSupported()) {
      console.warn('[VoiceInput] Intelligent MediaRecorder/getUserMedia pipeline not supported');
      this.smartVoiceSupported = false;
    } else {
      this.smartVoiceSupported = true;
    }

    this.updateButtonState();

  }

  toggleIntelligentListening() {
    if (!this.smartVoiceSupported || this.isProcessing || this.isStopping) return;
    if (this.isListening || this.isRecorderActive()) {
      this.stopListening();
      return;
    }
    this.startListening();
  }

  async startListening() {
    if (!this.smartVoiceSupported || this.isListening || this.isProcessing) return;
    if (this.dictation?.getState().isListening || this.dictation?.getState().isStopping) {
      this.showNotification('Finish dictation before starting intelligent voice.');
      return;
    }

    try {
      this.audioChunks = [];
      this.startedAt = Date.now();
      this.lastSoundDetectedAt = this.startedAt;
      this.hasDetectedSpeech = false;

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      await this.setupAudioAnalyser(this.mediaStream);

      const mimeType = this.getPreferredMimeType();
      this.currentMimeType = mimeType || '';
      this.mediaRecorder = new MediaRecorder(
        this.mediaStream,
        mimeType ? { mimeType } : undefined
      );

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };
      this.mediaRecorder.onerror = (event) => {
        console.error('[VoiceInput] MediaRecorder error:', event.error || event);
        this.showNotification('Could not record audio. Please try again.');
        this.stopListening({ discard: true });
      };
      this.mediaRecorder.onstop = () => {
        this.handleRecordingStopped();
      };

      this.mediaRecorder.start(250);
      this.isListening = true;
      this.updateButtonState();
      this.startAudioMonitoring();
      this.triggerHaptic('medium');

    } catch (error) {
      console.error('[VoiceInput] Failed to start cloud mic:', error);
      this.cleanupRecordingResources();
      this.showNotification(this.getStartErrorMessage(error));
    }
  }

  stopListening(options = {}) {
    if (!this.isListening && !this.mediaRecorder) return;

    this.isListening = false;
    this.isStopping = true;
    this.updateButtonState();
    this.triggerHaptic('light');

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.discardCurrentRecording = Boolean(options.discard);
      this.mediaRecorder.stop();
      return;
    }

    this.cleanupRecordingResources();
  }

  async handleRecordingStopped() {
    const generation = this.recordingGeneration;
    const discard = this.discardCurrentRecording;
    const mimeType = this.currentMimeType;
    this.discardCurrentRecording = false;
    this.cleanupRecordingResources({ keepChunks: true });
    this.isStopping = false;

    if (discard) {
      this.audioChunks = [];
      this.updateButtonState();
      return;
    }

    const chunks = this.audioChunks;
    this.audioChunks = [];

    if (!chunks.length) {
      this.showNotification('No speech detected.');
      this.updateButtonState();
      return;
    }

    this.isProcessing = true;
    this.updateButtonState();

    try {
      const sourceBlob = new Blob(chunks, { type: chunks[0]?.type || mimeType || 'audio/webm' });
      const wavBase64 = await this.prepareAudioForCloud(sourceBlob);
      if (generation !== this.recordingGeneration) return;
      this.transcriptionController = new AbortController();
      const text = await this.transcribeWithCloudMic(wavBase64, this.transcriptionController.signal);
      if (generation !== this.recordingGeneration) return;
      this.appendTranscriptToInput(text);
      this.triggerHaptic('medium');
    } catch (error) {
      if (error.name === 'AbortError' || generation !== this.recordingGeneration) return;
      console.error('[VoiceInput] Cloud mic transcription failed:', error);
      this.showNotification(error.message || 'Voice input failed. Please try again.');
    } finally {
      if (generation === this.recordingGeneration) {
        this.isProcessing = false;
        this.isStopping = false;
        this.updateButtonState();
      }
    }
  }

  async setupAudioAnalyser(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.65;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeDomainArray = new Uint8Array(this.analyser.fftSize);

    this.microphone = this.audioContext.createMediaStreamSource(stream);
    this.microphone.connect(this.analyser);
  }

  startAudioMonitoring() {
    const monitor = () => {
      if (!this.isListening) return;

      if (this.analyser && this.timeDomainArray) {
        this.analyser.getByteTimeDomainData(this.timeDomainArray);
        const rms = this.calculateRms(this.timeDomainArray);
        if (rms > this.silenceThreshold) {
          this.hasDetectedSpeech = true;
          this.lastSoundDetectedAt = Date.now();
        }
      }

      this.maybeAutoStopForSilence();
      this.maybeAutoStopForMaxLength();
      this.animationId = requestAnimationFrame(monitor);
    };

    monitor();
  }

  maybeAutoStopForSilence() {
    const elapsed = Date.now() - this.startedAt;
    const silentFor = Date.now() - this.lastSoundDetectedAt;
    if (
      this.isListening &&
      this.hasDetectedSpeech &&
      elapsed > MIN_RECORDING_BEFORE_SILENCE_MS &&
      silentFor > SILENCE_AUTO_STOP_MS
    ) {

      this.stopListening();
    }
  }

  maybeAutoStopForMaxLength() {
    if (this.isListening && Date.now() - this.startedAt > MAX_AUDIO_SECONDS * 1000) {

      this.stopListening();
    }
  }

  async prepareAudioForCloud(sourceBlob) {
    const arrayBuffer = await sourceBlob.arrayBuffer();
    const decodeContext = new (window.AudioContext || window.webkitAudioContext)();

    try {
      const decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));
      const mono = this.mixToMono(decoded);
      const resampled = await this.resampleAudio(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
      const normalized = this.normalizeAudio(resampled);
      const trimmed = this.trimSilence(normalized, TARGET_SAMPLE_RATE);
      const duration = trimmed.length / TARGET_SAMPLE_RATE;

      if (duration < MIN_AUDIO_SECONDS) {
        throw new Error('No speech detected.');
      }
      if (duration > MAX_AUDIO_SECONDS) {
        throw new Error('Voice input is too long. Please keep it under 2 minutes.');
      }

      const wavBytes = this.encodeWavPcm16(trimmed, TARGET_SAMPLE_RATE);
      return this.arrayBufferToBase64(wavBytes.buffer);
    } finally {
      decodeContext.close?.();
    }
  }

  async transcribeWithCloudMic(audioBase64, signal) {
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error('Please sign in before using voice input.');
    }

    const response = await fetch(CLOUD_MIC_ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        audio: audioBase64,
        format: 'wav',
        language: 'en'
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || payload.message || 'Voice input service is unavailable.');
    }

    const text = String(payload.text || payload.raw_text || '').trim();
    if (!text) {
      throw new Error('No speech detected.');
    }

    return text;
  }

  async getAccessToken() {
    await supabase.auth.refreshSession();
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.error('[VoiceInput] Failed to get session:', error);
      return null;
    }
    return data?.session?.access_token || null;
  }

  mixToMono(audioBuffer) {
    const output = new Float32Array(audioBuffer.length);
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      const data = audioBuffer.getChannelData(channel);
      for (let i = 0; i < data.length; i++) {
        output[i] += data[i] / audioBuffer.numberOfChannels;
      }
    }
    return output;
  }

  async resampleAudio(samples, sourceRate, targetRate) {
    if (sourceRate === targetRate) return samples;

    const bufferContext = new OfflineAudioContext(1, samples.length, sourceRate);
    const sourceBuffer = bufferContext.createBuffer(1, samples.length, sourceRate);
    sourceBuffer.copyToChannel(samples, 0);

    const targetLength = Math.ceil(samples.length * targetRate / sourceRate);
    const offlineContext = new OfflineAudioContext(1, targetLength, targetRate);
    const source = offlineContext.createBufferSource();
    source.buffer = sourceBuffer;
    source.connect(offlineContext.destination);
    source.start(0);

    const rendered = await offlineContext.startRendering();
    return rendered.getChannelData(0).slice();
  }

  normalizeAudio(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    if (peak < 0.01) return samples;

    const gain = Math.min(1 / peak, 6);
    const output = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      output[i] = Math.max(-1, Math.min(1, samples[i] * gain));
    }
    return output;
  }

  trimSilence(samples, sampleRate) {
    const threshold = 0.012;
    const padding = Math.floor(sampleRate * 0.16);
    let start = 0;
    let end = samples.length - 1;

    while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
    while (end > start && Math.abs(samples[end]) < threshold) end--;

    start = Math.max(0, start - padding);
    end = Math.min(samples.length - 1, end + padding);
    return samples.slice(start, end + 1);
  }

  encodeWavPcm16(samples, sampleRate) {
    const bytesPerSample = 2;
    const blockAlign = bytesPerSample;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    this.writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
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
    view.setUint32(40, samples.length * bytesPerSample, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    return new Uint8Array(buffer);
  }

  appendTranscriptToInput(transcript) {
    const cleanText = String(transcript || '').trim();
    if (!this.inputField || !cleanText) return;

    const currentValue = this.inputField.value.trim();
    this.inputField.value = currentValue ? `${currentValue} ${cleanText}` : cleanText;
    this.inputField.dispatchEvent(new Event('input', { bubbles: true }));
    this.inputField.focus();
  }

  cleanupRecordingResources(options = {}) {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
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
      this.audioContext.close?.();
      this.audioContext = null;
    }

    this.analyser = null;
    this.dataArray = null;
    this.timeDomainArray = null;
    this.mediaRecorder = null;
    this.currentMimeType = '';
    if (!options.keepChunks) {
      this.audioChunks = [];
    }
  }

  updateButtonState() {
    if (!this.micButton) return;

    const intelligentActive = this.isListening || this.isStopping || this.isProcessing;
    const processingActive = this.isStopping || this.isProcessing;
    if (this.voiceStateSwap) {
      this.voiceStateSwap.dataset.state = processingActive ? 'b' : 'a';
    }
    this.composingOrb?.setPaused(!this.isListening);
    if (this.dictationButton && intelligentActive) {
      this.dictationButton.disabled = true;
    }

    document.dispatchEvent(new CustomEvent('composerStateChanged', {
      detail: { source: 'intelligent-voice', state: this.getState() },
    }));
  }

  getState() {
    return {
      smartVoiceSupported: Boolean(this.smartVoiceSupported),
      dictationSupported: Boolean(this.dictation?.recognition),
      intelligentListening: this.isListening,
      intelligentStopping: this.isStopping,
      intelligentProcessing: this.isProcessing,
      dictationListening: Boolean(this.dictation?.getState().isListening),
      dictationStopping: Boolean(this.dictation?.getState().isStopping),
    };
  }

  async stopAll({ discard = false } = {}) {
    if (discard) {
      this.recordingGeneration += 1;
      this.transcriptionController?.abort();
      this.isProcessing = false;
    }
    if (this.dictation?.getState().isListening) {
      await this.dictation.stop({ discard });
    }
    if (this.isListening || this.isRecorderActive()) {
      this.stopListening({ discard });
    }
  }

  isRecorderActive() {
    return Boolean(this.mediaRecorder && this.mediaRecorder.state !== 'inactive');
  }

  getPreferredMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/ogg;codecs=opus'
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  getStartErrorMessage(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
      return 'Microphone permission denied. Please allow microphone access.';
    }
    if (error?.name === 'NotFoundError') {
      return 'No microphone found.';
    }
    return 'Could not start voice input. Please check microphone permissions.';
  }

  calculateRms(timeDomainArray) {
    let sumSquares = 0;
    for (let i = 0; i < timeDomainArray.length; i++) {
      const centered = (timeDomainArray[i] - 128) / 128;
      sumSquares += centered * centered;
    }
    return Math.sqrt(sumSquares / timeDomainArray.length);
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

  triggerHaptic() {}

  isSupported() {
    return Boolean(
      navigator.mediaDevices?.getUserMedia &&
      window.MediaRecorder &&
      (window.AudioContext || window.webkitAudioContext)
    );
  }

  showNotification(message) {
    if (window.chat && typeof window.chat.showNotification === 'function') {
      window.chat.showNotification(message, 'error');
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
      background: var(--error-bg, #ff4444);
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
}

export default VoiceInputHandler;
