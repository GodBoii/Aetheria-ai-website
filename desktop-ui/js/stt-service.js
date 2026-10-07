const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

class SttService {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.modelFileName = options.modelFileName || 'ggml-large-v3-turbo.bin';
        this.maxAudioSamples = options.maxAudioSamples || 30 * 60 * 16000; // 30 minutes @ 16kHz
        this.defaultTimeoutMs = options.defaultTimeoutMs || 12 * 60 * 1000;
    }

    getResourceRoot() {
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'stt');
        }
        return path.join(app.getAppPath(), 'resources', 'stt');
    }

    getModelPath() {
        return path.join(this.getResourceRoot(), 'models', this.modelFileName);
    }

    getPlatformKey() {
        return `${process.platform}-${process.arch}`;
    }

    getBinaryCandidates() {
        const key = this.getPlatformKey();

        switch (key) {
            case 'win32-x64':
                return [
                    { backend: 'cuda', binary: path.join('bin', 'win32-x64', 'cuda', 'whisper-cli.exe'), useGpu: true },
                    { backend: 'cpu', binary: path.join('bin', 'win32-x64', 'cpu', 'whisper-cli.exe'), useGpu: false },
                ];
            case 'darwin-arm64':
                return [
                    { backend: 'coreml', binary: path.join('bin', 'darwin-arm64', 'coreml', 'whisper-cli'), useGpu: true },
                    { backend: 'cpu', binary: path.join('bin', 'darwin-arm64', 'cpu', 'whisper-cli'), useGpu: false },
                ];
            case 'darwin-x64':
                return [
                    { backend: 'cpu', binary: path.join('bin', 'darwin-x64', 'cpu', 'whisper-cli'), useGpu: false },
                ];
            case 'linux-x64':
                return [
                    { backend: 'vulkan', binary: path.join('bin', 'linux-x64', 'vulkan', 'whisper-cli'), useGpu: true },
                    { backend: 'cpu', binary: path.join('bin', 'linux-x64', 'cpu', 'whisper-cli'), useGpu: false },
                ];
            default:
                return [];
        }
    }

    resolveExecutable() {
        const resourceRoot = this.getResourceRoot();
        const candidates = this.getBinaryCandidates();

        for (const candidate of candidates) {
            const binaryPath = path.join(resourceRoot, candidate.binary);
            if (fs.existsSync(binaryPath)) {
                return {
                    ...candidate,
                    path: binaryPath,
                };
            }
        }

        return null;
    }

    async ensureExecutable(binaryPath) {
        if (process.platform !== 'win32') {
            await fs.promises.chmod(binaryPath, 0o755).catch(() => {});
        }
    }

    getStatus() {
        const modelPath = this.getModelPath();
        const executable = this.resolveExecutable();
        const modelExists = fs.existsSync(modelPath);

        return {
            ready: Boolean(executable && modelExists),
            platform: process.platform,
            arch: process.arch,
            resourceRoot: this.getResourceRoot(),
            modelPath,
            modelExists,
            selectedBackend: executable ? executable.backend : null,
            binaryPath: executable ? executable.path : null,
            binaryCandidates: this.getBinaryCandidates().map((entry) => ({
                backend: entry.backend,
                path: path.join(this.getResourceRoot(), entry.binary),
                exists: fs.existsSync(path.join(this.getResourceRoot(), entry.binary)),
            })),
        };
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

    extractTranscript(jsonData) {
        if (!jsonData || typeof jsonData !== 'object') {
            return '';
        }

        if (typeof jsonData.text === 'string') {
            return jsonData.text.trim();
        }

        if (Array.isArray(jsonData.transcription)) {
            return jsonData.transcription
                .map((segment) => (segment && typeof segment.text === 'string' ? segment.text : ''))
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        if (Array.isArray(jsonData.segments)) {
            return jsonData.segments
                .map((segment) => (segment && typeof segment.text === 'string' ? segment.text : ''))
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        return '';
    }

    async transcribe(payload = {}) {
        const audioFloat32 = this.normalizeFloat32Audio(payload.audio);
        const sampleRate = Number(payload.sampleRate || 16000);
        const language = typeof payload.language === 'string' && payload.language.trim() ? payload.language.trim() : 'auto';
        const timeoutMs = Number(payload.timeoutMs || this.defaultTimeoutMs);
        const includeTimestamps = Boolean(payload.includeTimestamps);

        if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
            throw new Error('Invalid sample rate provided for transcription.');
        }

        if (!audioFloat32.length) {
            throw new Error('No audio samples received for transcription.');
        }

        if (audioFloat32.length > this.maxAudioSamples) {
            throw new Error('Audio segment is too long. Please send shorter chunks.');
        }

        const status = this.getStatus();
        if (!status.ready) {
            throw new Error('Local STT is not ready. Whisper binary or model is missing.');
        }

        const executables = this.getBinaryCandidates()
            .map((candidate) => ({
                ...candidate,
                path: path.join(this.getResourceRoot(), candidate.binary),
            }))
            .filter((candidate) => fs.existsSync(candidate.path));

        if (!executables.length) {
            throw new Error('No compatible whisper-cli binary found for this platform.');
        }

        const tempBase = path.join(app.getPath('temp'), 'aetheria-stt');
        await fs.promises.mkdir(tempBase, { recursive: true });

        const requestTag = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const wavPath = path.join(tempBase, `${requestTag}.wav`);
        const wavBuffer = this.encodeWavPcm16(audioFloat32, sampleRate);
        await fs.promises.writeFile(wavPath, wavBuffer);
        const cleanupAttemptOutputs = async (outputPrefix) => {
            await Promise.allSettled([
                fs.promises.unlink(`${outputPrefix}.json`),
                fs.promises.unlink(`${outputPrefix}.txt`),
                fs.promises.unlink(`${outputPrefix}.srt`),
                fs.promises.unlink(`${outputPrefix}.vtt`),
                fs.promises.unlink(`${outputPrefix}.csv`),
                fs.promises.unlink(`${outputPrefix}.lrc`),
                fs.promises.unlink(`${outputPrefix}.wts`),
            ]);
        };

        const startedAt = Date.now();
        const attemptedBackends = [];
        const backendErrors = [];

        try {
            for (const executable of executables) {
                attemptedBackends.push(executable.backend);
                await this.ensureExecutable(executable.path);

                const outputPrefix = path.join(tempBase, `${requestTag}.${executable.backend}.out`);
                const outputJsonPath = `${outputPrefix}.json`;

                const args = [
                    '-m',
                    status.modelPath,
                    '-f',
                    wavPath,
                    '-oj',
                    '-of',
                    outputPrefix,
                    '-t',
                    String(Math.max(1, Math.min(os.cpus().length || 4, 8))),
                    '-pp',
                ];

                if (!includeTimestamps) {
                    args.push('-nt');
                }

                if (!executable.useGpu) {
                    args.push('-ng');
                }

                if (language && language !== 'auto') {
                    args.push('-l', language);
                } else {
                    args.push('-l', 'auto');
                }

                this.logger.log('[STT] Starting whisper transcription', {
                    backend: executable.backend,
                    sampleRate,
                    samples: audioFloat32.length,
                });

                try {
                    await new Promise((resolve, reject) => {
                        let stdout = '';
                        let stderr = '';
                        let settled = false;

                        const proc = spawn(executable.path, args, {
                            windowsHide: true,
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });

                        const cleanupTimeout = setTimeout(() => {
                            if (settled) return;
                            settled = true;
                            proc.kill('SIGKILL');
                            reject(new Error(`Local transcription timed out after ${timeoutMs} ms.`));
                        }, timeoutMs);

                        proc.stdout.on('data', (chunk) => {
                            stdout += chunk.toString();
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

                            if (code !== 0) {
                                reject(new Error(`whisper-cli exited with code ${code}. ${stderr || stdout}`));
                                return;
                            }

                            resolve({ stdout, stderr });
                        });
                    });

                    let parsed = null;
                    try {
                        const rawJson = await fs.promises.readFile(outputJsonPath, 'utf8');
                        parsed = JSON.parse(rawJson);
                    } catch (error) {
                        this.logger.warn('[STT] Failed to parse whisper JSON output, falling back to empty transcript', {
                            error: error.message,
                            backend: executable.backend,
                        });
                    }

                    const text = this.extractTranscript(parsed);
                    const durationMs = Date.now() - startedAt;
                    this.logger.log('[STT] Completed whisper transcription', {
                        backend: executable.backend,
                        durationMs,
                        textLength: text.length,
                    });

                    await cleanupAttemptOutputs(outputPrefix);

                    return {
                        ok: true,
                        text,
                        backend: executable.backend,
                        durationMs,
                        meta: {
                            sampleRate,
                            samples: audioFloat32.length,
                            language,
                            attemptedBackends,
                        },
                    };
                } catch (error) {
                    backendErrors.push(`${executable.backend}: ${error.message}`);
                    this.logger.warn('[STT] Backend failed, trying next fallback if available', {
                        backend: executable.backend,
                        error: error.message,
                    });
                    await cleanupAttemptOutputs(outputPrefix);
                }
            }
        } finally {
            await Promise.allSettled([fs.promises.unlink(wavPath)]);
        }

        throw new Error(`All STT backends failed. ${backendErrors.join(' | ')}`);
    }
}

module.exports = SttService;
