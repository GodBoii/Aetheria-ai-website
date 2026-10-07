// Dictation uses the browser's speech service. Cloud voice is a separate action.
export default class BrowserDictationController {
    constructor({ button, input, onStateChange, notify }) {
        this.button = button;
        this.input = input;
        this.onStateChange = onStateChange;
        this.notify = notify;
        this.isListening = false;
        this.isStopping = false;
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            button.disabled = true;
            button.title = 'Dictation is unavailable in this browser. Use intelligent voice instead.';
            return;
        }
        this.recognition = new Recognition();
        this.recognition.lang = navigator.language || 'en-US';
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.onresult = event => {
            let final = '';
            let interim = '';
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                if (result.isFinal) final += result[0].transcript;
                else interim += result[0].transcript;
            }
            this.prefix += final;
            input.value = this.prefix + interim;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        this.recognition.onend = () => {
            if (this.discard) input.value = this.original;
            this.isListening = false;
            this.isStopping = false;
            this.render();
        };
        this.recognition.onerror = event => {
            if (event.error !== 'aborted') notify(event.error === 'not-allowed'
                ? 'Allow microphone access to use dictation.' : 'Dictation stopped. Try intelligent voice instead.');
        };
        button.addEventListener('click', () => {
            if (this.isListening) this.stop();
            else this.start();
        });
    }

    start() {
        if (!this.recognition || this.isStopping) return;
        this.original = this.input.value;
        this.prefix = this.original ? `${this.original.trimEnd()} ` : '';
        this.discard = false;
        try {
            this.recognition.start();
            this.isListening = true;
            this.render();
        } catch (error) {
            this.notify(error.message || 'Could not start dictation.');
        }
    }

    stop({ discard = false } = {}) {
        if (!this.isListening) return;
        this.discard = discard;
        this.isStopping = true;
        this.recognition.stop();
        this.render();
    }

    getState() {
        return { isListening: this.isListening, isStopping: this.isStopping };
    }

    render() {
        this.button.classList.toggle('recording', this.isListening);
        this.button.setAttribute('aria-pressed', String(this.isListening));
        this.button.setAttribute('aria-label', this.isListening ? 'Stop dictation' : 'Start dictation');
        this.onStateChange();
    }
}
