const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

const DEFAULT_MODEL_NAME = 'vosk-model-small-en-us-0.15';
const DEFAULT_MODEL_URL = `https://alphacephei.com/vosk/models/${DEFAULT_MODEL_NAME}.zip`;

class VoskSttService {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.modelName = options.modelName || DEFAULT_MODEL_NAME;
        this.modelUrl = options.modelUrl || DEFAULT_MODEL_URL;
        this.maxAudioSamples = options.maxAudioSamples || 5 * 60 * 16000;
        this.defaultTimeoutMs = options.defaultTimeoutMs || 2 * 60 * 1000;
        this.downloadInProgress = false;
    }

    getPythonCommand() {
        if (process.env.AETHERIA_PYTHON_PATH) {
            return process.env.AETHERIA_PYTHON_PATH;
        }
        return process.platform === 'win32' ? 'python' : 'python3';
    }

    getHelperPath() {
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'python-backend', 'vosk_stt.py');
        }
        return path.join(app.getAppPath(), 'python-backend', 'vosk_stt.py');
    }

    getBundledModelRoot() {
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'vosk', 'models');
        }
        return path.join(app.getAppPath(), 'resources', 'vosk', 'models');
    }

    getUserModelRoot() {
        return path.join(app.getPath('userData'), 'vosk', 'models');
    }

    normalizeFloat32Audio(audio) {
        if (audio instanceof Float32Array) {
            return audio;
        }

        if (ArrayBuffer.isView(audio) && audio.buffer) {
            return new Float32Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
        }

        if (audio instanceof ArrayBuffer) {
            return new Float32Array(audio);
        }

        if (Array.isArray(audio)) {
            return Float32Array.from(audio);
        }

        throw new Error('Unsupported audio payload format. Expected Float32Array-compatible data.');
    }

    encodeWavPcm16(float32, sampleRate) {
        const numChannels = 1;
        const bitsPerSample = 16;
        const blockAlign = numChannels * (bitsPerSample / 8);
        const byteRate = sampleRate * blockAlign;
        const dataSize = float32.length * 2;
        const buffer = Buffer.alloc(44 + dataSize);

        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(36 + dataSize, 4);
        buffer.write('WAVE', 8);
        buffer.write('fmt ', 12);
        buffer.writeUInt32LE(16, 16);
        buffer.writeUInt16LE(1, 20);
        buffer.writeUInt16LE(numChannels, 22);
        buffer.writeUInt32LE(sampleRate, 24);
        buffer.writeUInt32LE(byteRate, 28);
        buffer.writeUInt16LE(blockAlign, 32);
        buffer.writeUInt16LE(bitsPerSample, 34);
        buffer.write('data', 36);
        buffer.writeUInt32LE(dataSize, 40);

        let offset = 44;
        for (let i = 0; i < float32.length; i++) {
            const clamped = Math.max(-1, Math.min(1, float32[i]));
            const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
            buffer.writeInt16LE(Math.round(int16), offset);
            offset += 2;
        }

        return buffer;
    }

    parseJsonLines(output) {
        return output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch (error) {
                    return { type: 'log', message: line };
                }
            });
    }

    runHelper(args, options = {}) {
        const timeoutMs = Number(options.timeoutMs || this.defaultTimeoutMs);
        const onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;

        return new Promise((resolve, reject) => {
            const helperPath = this.getHelperPath();
            if (!fs.existsSync(helperPath)) {
                reject(new Error(`Vosk helper not found: ${helperPath}`));
                return;
            }

            const proc = spawn(this.getPythonCommand(), [helperPath, ...args], {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';
            let stdoutRemainder = '';
            let settled = false;

            const cleanupTimeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                proc.kill('SIGKILL');
                reject(new Error(`Vosk helper timed out after ${timeoutMs} ms.`));
            }, timeoutMs);

            proc.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                stdout += text;
                if (!onMessage) return;

                const combined = stdoutRemainder + text;
                const lines = combined.split(/\r?\n/);
                stdoutRemainder = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        onMessage(JSON.parse(line));
                    } catch (error) {
                        onMessage({ type: 'log', message: line });
                    }
                }
            });

            proc.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            proc.on('error', (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(cleanupTimeout);
                reject(error);
            });

            proc.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(cleanupTimeout);

                if (stdoutRemainder.trim() && onMessage) {
                    try {
                        onMessage(JSON.parse(stdoutRemainder));
                    } catch (error) {
                        onMessage({ type: 'log', message: stdoutRemainder });
                    }
                }

                const messages = this.parseJsonLines(stdout);
                const errorMessage = messages.find((message) => message.type === 'error');
                if (code !== 0 || errorMessage) {
                    reject(new Error(errorMessage?.error || stderr || `Vosk helper exited with code ${code}.`));
                    return;
                }

                resolve({ messages, stdout, stderr });
            });
        });
    }

    async getStatus() {
        const roots = [this.getBundledModelRoot(), this.getUserModelRoot()];
        for (const root of roots) {
            const result = await this.runHelper(['status', '--model-root', root, '--model-name', this.modelName], {
                timeoutMs: 15000,
            }).catch((error) => ({ error }));

            if (result.error) {
                this.logger.warn('[VoskSTT] Status check failed', {
                    root,
                    error: result.error.message,
                });
                continue;
            }

            const status = result.messages.find((message) => message.type === 'status');
            if (status?.ready) {
                return {
                    ready: true,
                    modelPath: status.modelPath,
                    modelRoot: root,
                    modelName: this.modelName,
                    helperPath: this.getHelperPath(),
                };
            }
        }

        return {
            ready: false,
            modelPath: null,
            modelRoot: this.getUserModelRoot(),
            modelName: this.modelName,
            helperPath: this.getHelperPath(),
        };
    }

    async downloadDefaultModel(onProgress) {
        if (this.downloadInProgress) {
            throw new Error('Vosk model download is already in progress.');
        }

        this.downloadInProgress = true;
        try {
            const result = await this.runHelper([
                'download-model',
                '--model-root',
                this.getUserModelRoot(),
                '--model-name',
                this.modelName,
                '--url',
                this.modelUrl,
            ], {
                timeoutMs: 10 * 60 * 1000,
                onMessage: onProgress,
            });

            const complete = result.messages.find((message) => message.type === 'complete');
            return {
                ok: true,
                modelPath: complete?.modelPath || null,
                alreadyExists: Boolean(complete?.alreadyExists),
            };
        } finally {
            this.downloadInProgress = false;
        }
    }

    cleanTranscript(text) {
        return String(text || '')
            .replace(/\b(uh+|um+|umm+|hmm+|ah+|er+|eh+)\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    async transcribe(payload = {}) {
        const audioFloat32 = this.normalizeFloat32Audio(payload.audio);
        const sampleRate = Number(payload.sampleRate || 16000);
        const timeoutMs = Number(payload.timeoutMs || this.defaultTimeoutMs);

        if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
            throw new Error('Invalid sample rate provided for transcription.');
        }

        if (!audioFloat32.length) {
            throw new Error('No audio samples received for transcription.');
        }

        if (audioFloat32.length > this.maxAudioSamples) {
            throw new Error('Audio segment is too long. Please send shorter chunks.');
        }

        const status = await this.getStatus();
        if (!status.ready) {
            throw new Error('Vosk STT model is not ready. Download the model first.');
        }

        const tempBase = path.join(app.getPath('temp'), 'aetheria-vosk-stt');
        await fs.promises.mkdir(tempBase, { recursive: true });

        const requestTag = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const wavPath = path.join(tempBase, `${requestTag}.wav`);
        const wavBuffer = this.encodeWavPcm16(audioFloat32, sampleRate);
        await fs.promises.writeFile(wavPath, wavBuffer);

        const startedAt = Date.now();
        try {
            const result = await this.runHelper([
                'transcribe',
                '--model-path',
                status.modelPath,
                '--wav',
                wavPath,
            ], { timeoutMs });

            const transcription = result.messages.find((message) => message.type === 'result') || {};
            const rawText = String(transcription.text || '').trim();
            const text = this.cleanTranscript(rawText);
            return {
                ok: true,
                text,
                rawText,
                backend: 'vosk',
                durationMs: Date.now() - startedAt,
                meta: {
                    sampleRate,
                    samples: audioFloat32.length,
                    modelPath: status.modelPath,
                    words: transcription.words || [],
                },
            };
        } finally {
            await fs.promises.unlink(wavPath).catch(() => {});
        }
    }
}

module.exports = VoskSttService;
