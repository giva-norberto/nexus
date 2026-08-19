// Nexus Voice + Autonomy v1.2
// Voz usa recursos nativos do navegador com proteção específica para mobile/WebKit.
// Autonomia continua somente leitura pelo Agent Core existente.
(() => {
  const STORAGE = {
    voiceEnabled: 'nexusVoiceEnabled',
    autoSendVoice: 'nexusVoiceAutoSend',
    autonomyEnabled: 'nexusAutonomyEnabled'
  };

  const MOBILE_RE = /Android|iPhone|iPad|iPod|Mobile/i;
  const isMobile = MOBILE_RE.test(navigator.userAgent || '');
  const hasSpeechSynthesis = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  const MALE_VOICE_HINTS = [
    'felipe', 'daniel', 'antonio', 'antônio', 'paulo', 'joao', 'joão', 'jorge',
    'carlos', 'ricardo', 'thiago', 'tiago', 'eduardo', 'rafael', 'marcelo', 'bruno'
  ];
  const FEMALE_VOICE_HINTS = [
    'luciana', 'francisca', 'leticia', 'letícia', 'mariana', 'camila', 'fernanda',
    'vitoria', 'vitória', 'helena', 'paulina', 'maria'
  ];
  const NATURAL_VOICE_HINTS = ['natural', 'neural', 'enhanced', 'premium', 'online'];

  const state = {
    listening: false,
    recognition: null,
    finalTranscript: '',
    autonomyRunning: false,
    voiceEnabled: localStorage.getItem(STORAGE.voiceEnabled) !== 'false',
    autoSendVoice: localStorage.getItem(STORAGE.autoSendVoice) !== 'false',
    autonomyEnabled: localStorage.getItem(STORAGE.autonomyEnabled) !== 'false',
    audioUnlocked: !isMobile,
    pendingSpeech: '',
    speechQueue: [],
    activeUtterance: null,
    speechGeneration: 0,
    voiceRetry: 0
  };

  function normalize(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripForSpeech(value) {
    return String(value || '')
      .replace(/```[\s\S]*?```/g, ' trecho de código omitido na leitura. ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*|__|~~|[#>|]/g, '')
      .replace(/\[(.*?)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  }

  function splitForMobileSpeech(text, maxLength = 240) {
    const cleaned = stripForSpeech(text);
    if (!cleaned) return [];
    const sentences = cleaned.match(/[^.!?;:]+[.!?;:]?|[^.!?;:]+$/g) || [cleaned];
    const chunks = [];
    let current = '';

    for (const sentenceRaw of sentences) {
      const sentence = sentenceRaw.trim();
      if (!sentence) continue;
      if ((current + ' ' + sentence).trim().length <= maxLength) {
        current = (current + ' ' + sentence).trim();
        continue;
      }
      if (current) chunks.push(current);
      if (sentence.length <= maxLength) {
        current = sentence;
        continue;
      }
      const words = sentence.split(/\s+/);
      current = '';
      for (const word of words) {
        if ((current + ' ' + word).trim().length > maxLength && current) {
          chunks.push(current);
          current = word;
        } else {
          current = (current + ' ' + word).trim();
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function voiceScore(voice) {
    const name = normalize(voice?.name);
    const lang = String(voice?.lang || '').replace('_', '-').toLowerCase();
    let score = 0;

    if (lang === 'pt-br') score += 220;
    else if (lang.startsWith('pt-')) score += 120;
    else if (/portugu/.test(name)) score += 70;
    else return -1000;

    if (MALE_VOICE_HINTS.some((hint) => name.includes(normalize(hint)))) score += 160;
    if (FEMALE_VOICE_HINTS.some((hint) => name.includes(normalize(hint)))) score -= 180;
    if (NATURAL_VOICE_HINTS.some((hint) => name.includes(hint))) score += 35;
    if (voice?.localService) score += 8;
    if (voice?.default) score += 4;

    return score;
  }

  function choosePortugueseVoice() {
    if (!hasSpeechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    const candidates = voices
      .map((voice, index) => ({ voice, index, score: voiceScore(voice) }))
      .filter((item) => item.score > -1000)
      .sort((a, b) => (b.score - a.score) || (a.index - b.index));

    return candidates[0]?.voice || null;
  }

  function updateAudioButton() {
    const button = document.getElementById('nexusAudioBtn');
    if (!button) return;
    if (!hasSpeechSynthesis) {
      button.textContent = '🔇';
      button.title = 'Síntese de voz indisponível neste navegador';
      button.disabled = true;
      return;
    }
    button.textContent = state.audioUnlocked && state.voiceEnabled ? '🔊' : '🔈';
    button.title = state.audioUnlocked ? 'Testar voz do Nexus' : 'Ativar áudio do Nexus';
    button.setAttribute('aria-pressed', state.audioUnlocked && state.voiceEnabled ? 'true' : 'false');
    button.style.borderColor = state.audioUnlocked && state.voiceEnabled ? 'var(--ok)' : '';
    button.style.color = state.audioUnlocked && state.voiceEnabled ? 'var(--ok)' : '';
  }

  function setAudioStatus(text) {
    const status = document.getElementById('nexusMobileAudioStatus');
    if (status) status.textContent = text;
  }

  function stopSpeaking() {
    if (!hasSpeechSynthesis) return;
    state.speechGeneration += 1;
    state.speechQueue = [];
    state.activeUtterance = null;
    state.voiceRetry = 0;
    if (window.speechSynthesis.speaking || window.speechSynthesis.pending || window.speechSynthesis.paused) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
  }

  function playNextSpeech(generation) {
    if (!hasSpeechSynthesis || generation !== state.speechGeneration || !state.voiceEnabled) return;
    if (!state.speechQueue.length) {
      state.activeUtterance = null;
      state.voiceRetry = 0;
      setAudioStatus(state.audioUnlocked ? 'Áudio móvel ativo.' : 'Toque em 🔈 para ativar o áudio no celular.');
      return;
    }

    const voice = choosePortugueseVoice();
    if (!voice && window.speechSynthesis.getVoices().length === 0 && state.voiceRetry < 6) {
      state.voiceRetry += 1;
      setTimeout(() => playNextSpeech(generation), 180);
      return;
    }
    state.voiceRetry = 0;

    const chunk = state.speechQueue.shift();
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = 'pt-BR';
    utterance.rate = 0.92;
    utterance.pitch = 0.9;
    utterance.volume = 1;
    if (voice) utterance.voice = voice;

    state.activeUtterance = utterance; // mantém referência viva em navegadores móveis.
    utterance.onstart = () => setAudioStatus(voice ? `Nexus falando — ${voice.name}.` : 'Nexus falando...');
    utterance.onend = () => {
      if (generation !== state.speechGeneration) return;
      state.activeUtterance = null;
      setTimeout(() => playNextSpeech(generation), 35);
    };
    utterance.onerror = (event) => {
      const error = String(event?.error || 'erro');
      if (generation !== state.speechGeneration) return;
      state.activeUtterance = null;
      if (!/canceled|interrupted/i.test(error)) {
        console.warn('Nexus speech synthesis error', error);
        setAudioStatus(`Falha de áudio (${error}). Toque em 🔊 para testar novamente.`);
      }
      setTimeout(() => playNextSpeech(generation), 100);
    };

    try {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.error('Nexus speech synthesis failed', error);
      setAudioStatus('Não consegui iniciar o áudio. Toque em 🔊 para tentar novamente.');
    }
  }

  function startSpeech(text, { replace = true } = {}) {
    if (!state.voiceEnabled || !hasSpeechSynthesis) return;
    const chunks = splitForMobileSpeech(text);
    if (!chunks.length) return;

    // Em WebKit antigo, cancel() seguido imediatamente de speak() pode eliminar a nova fala.
    // Só cancelamos quando existe fala real em andamento e aguardamos antes de recomeçar.
    const wasActive = window.speechSynthesis.speaking || window.speechSynthesis.pending || window.speechSynthesis.paused;
    if (replace) {
      state.speechGeneration += 1;
      state.speechQueue = chunks;
      state.activeUtterance = null;
      state.voiceRetry = 0;
      if (wasActive) {
        try { window.speechSynthesis.cancel(); } catch (_) {}
        const generation = state.speechGeneration;
        setTimeout(() => playNextSpeech(generation), 180);
        return;
      }
    } else {
      state.speechQueue.push(...chunks);
    }

    playNextSpeech(state.speechGeneration);
  }

  function speak(text) {
    if (!state.voiceEnabled || !hasSpeechSynthesis) return;
    const cleaned = stripForSpeech(text);
    if (!cleaned) return;

    if (isMobile && !state.audioUnlocked) {
      state.pendingSpeech = cleaned;
      setAudioStatus('Toque em 🔈 uma vez para liberar o áudio no celular.');
      updateAudioButton();
      return;
    }
    startSpeech(cleaned, { replace: true });
  }

  function unlockAudio({ announce = true } = {}) {
    if (!hasSpeechSynthesis) {
      window.nexusAddMsg?.('assistant', 'A síntese de voz não está disponível neste navegador.');
      return;
    }

    state.voiceEnabled = true;
    state.audioUnlocked = true;
    localStorage.setItem(STORAGE.voiceEnabled, 'true');
    try { window.speechSynthesis.resume(); } catch (_) {}
    updateAudioButton();
    setAudioStatus('Áudio móvel liberado.');

    const pending = state.pendingSpeech;
    state.pendingSpeech = '';
    if (announce) {
      const text = pending ? `Áudio do Nexus ativado. ${pending}` : 'Áudio do Nexus ativado.';
      startSpeech(text, { replace: true });
    } else if (pending) {
      startSpeech(pending, { replace: true });
    }
  }

  function testAudio() {
    unlockAudio({ announce: false });
    startSpeech('Teste de áudio. Esta é a nova voz do Nexus, com ritmo mais natural.', { replace: true });
  }

  function setButtonListening(button, listening) {
    if (!button) return;
    button.textContent = listening ? '■' : '🎙';
    button.title = listening ? 'Parar de ouvir' : 'Falar com o Nexus';
    button.setAttribute('aria-pressed', listening ? 'true' : 'false');
    button.style.borderColor = listening ? 'var(--err)' : '';
    button.style.color = listening ? 'var(--err)' : '';
  }

  function stopListening() {
    if (state.recognition && state.listening) {
      try { state.recognition.stop(); } catch (_) {}
    }
  }

  function startListening() {
    if (!SpeechRecognition) {
      window.nexusAddMsg?.('assistant', 'Reconhecimento de voz não está disponível neste navegador. O chat por texto continua funcionando normalmente.');
      return;
    }
    if (state.listening) {
      stopListening();
      return;
    }

    const input = document.getElementById('input');
    const micButton = document.getElementById('nexusMicBtn');
    if (!input) return;

    // O toque no microfone também autoriza futuras respostas faladas no celular.
    state.audioUnlocked = true;
    updateAudioButton();
    stopSpeaking();

    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    state.recognition = recognition;
    state.finalTranscript = '';

    recognition.onstart = () => {
      state.listening = true;
      setButtonListening(micButton, true);
      input.placeholder = 'Ouvindo... fale com o Nexus';
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0]?.transcript || '';
        if (event.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }
      if (finalText.trim()) state.finalTranscript = finalText.trim();
      input.value = (state.finalTranscript || interim).trim();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    recognition.onerror = (event) => {
      const error = String(event?.error || 'erro desconhecido');
      if (error !== 'no-speech' && error !== 'aborted') {
        window.nexusAddMsg?.('assistant', `Não consegui captar sua voz (${error}). Você pode tentar novamente ou escrever a pergunta.`);
      }
    };

    recognition.onend = () => {
      state.listening = false;
      setButtonListening(micButton, false);
      input.placeholder = 'Pergunte ao Nexus...';
      const finalText = String(input.value || '').trim();
      if (state.autoSendVoice && finalText) {
        setTimeout(() => document.getElementById('composer')?.requestSubmit(), 120);
      }
    };

    try {
      recognition.start();
    } catch (error) {
      console.error('Nexus voice recognition start failed', error);
      state.listening = false;
      setButtonListening(micButton, false);
    }
  }

  function updateGovernanceDisplay() {
    document.querySelectorAll('.rule').forEach((rule) => {
      const label = normalize(rule.querySelector('span')?.textContent);
      const value = rule.querySelector('strong');
      if (!value) return;
      if (label === 'abrir pr') {
        value.textContent = 'PRÓXIMA ETAPA';
        value.classList.add('block');
      }
      if (label === 'merge / deploy') {
        value.textContent = 'CONFORME POLÍTICA';
        value.classList.add('block');
      }
    });

    [...document.querySelectorAll('header .badge')].forEach((badge) => {
      if (/^v0\.(7|8)$/i.test(badge.textContent.trim())) badge.textContent = 'v0.8.1';
    });
  }

  function ensureVoiceControls() {
    const composer = document.getElementById('composer');
    const sendButton = document.getElementById('sendBtn');
    if (!composer || !sendButton) return;

    if (!document.getElementById('nexusAudioBtn')) {
      const audio = document.createElement('button');
      audio.id = 'nexusAudioBtn';
      audio.className = 'btn';
      audio.type = 'button';
      audio.textContent = state.audioUnlocked ? '🔊' : '🔈';
      audio.setAttribute('aria-label', 'Ativar ou testar voz do Nexus');
      audio.addEventListener('click', testAudio);
      composer.insertBefore(audio, sendButton);
    }

    if (!document.getElementById('nexusMicBtn')) {
      const mic = document.createElement('button');
      mic.id = 'nexusMicBtn';
      mic.className = 'btn';
      mic.type = 'button';
      mic.textContent = '🎙';
      mic.title = SpeechRecognition ? 'Falar com o Nexus' : 'Voz indisponível neste navegador';
      mic.setAttribute('aria-label', 'Falar com o Nexus');
      mic.addEventListener('click', startListening);
      composer.insertBefore(mic, sendButton);
    }
    updateAudioButton();
  }

  function createSwitch(id, label, checked, onChange) {
    const row = document.createElement('label');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.gap = '10px';
    row.style.fontSize = '12px';
    row.style.padding = '5px 0';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = checked;
    input.style.width = 'auto';
    input.addEventListener('change', () => onChange(input.checked));
    row.append(text, input);
    return row;
  }

  function ensureSidebarControls() {
    const aside = document.querySelector('aside');
    if (!aside || document.getElementById('nexusVoiceAutonomyPanel')) return;

    const section = document.createElement('div');
    section.className = 'sec';
    section.id = 'nexusVoiceAutonomyPanel';
    const title = document.createElement('h2');
    title.textContent = 'Voz + Autonomia';
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="t">Nexus Voice + Autonomy v1.2</div>
      <div class="s">Voz pt-BR com preferência masculina, ritmo mais natural, compatibilidade móvel reforçada e ciclo autônomo real de investigação, somente leitura.</div>
    `;

    const mobileStatus = document.createElement('div');
    mobileStatus.id = 'nexusMobileAudioStatus';
    mobileStatus.className = 's';
    mobileStatus.style.margin = '8px 0';
    mobileStatus.textContent = hasSpeechSynthesis
      ? (state.audioUnlocked ? 'Áudio móvel ativo.' : 'No celular, toque em 🔈 ao lado de Enviar para liberar o áudio.')
      : 'Síntese de voz indisponível neste navegador.';
    card.appendChild(mobileStatus);

    card.appendChild(createSwitch('nexusVoiceToggle', 'Responder com voz', state.voiceEnabled, (checked) => {
      state.voiceEnabled = checked;
      localStorage.setItem(STORAGE.voiceEnabled, String(checked));
      if (!checked) stopSpeaking();
      updateAudioButton();
    }));
    card.appendChild(createSwitch('nexusAutoSendVoiceToggle', 'Enviar ao terminar de falar', state.autoSendVoice, (checked) => {
      state.autoSendVoice = checked;
      localStorage.setItem(STORAGE.autoSendVoice, String(checked));
    }));
    card.appendChild(createSwitch('nexusAutonomyToggle', 'Autonomia segura', state.autonomyEnabled, (checked) => {
      state.autonomyEnabled = checked;
      localStorage.setItem(STORAGE.autonomyEnabled, String(checked));
    }));

    const test = document.createElement('button');
    test.className = 'btn';
    test.type = 'button';
    test.textContent = 'Testar áudio';
    test.style.marginTop = '8px';
    test.addEventListener('click', testAudio);
    card.appendChild(test);

    const policy = document.createElement('div');
    policy.className = 's';
    policy.style.marginTop = '8px';
    policy.textContent = 'Permitido agora: observar, investigar e recomendar. Bloqueado nesta versão: escrita em produção, Rules/IAM, exclusões, custos e deploy de Functions.';
    card.appendChild(policy);

    section.append(title, card);
    const governance = aside.querySelector('.sec');
    if (governance?.nextSibling) aside.insertBefore(section, governance.nextSibling);
    else aside.appendChild(section);
  }

  async function runAutonomy() {
    if (!state.autonomyEnabled) {
      window.nexusAddMsg?.('assistant', 'A autonomia segura está desligada. Ative-a no painel “Voz + Autonomia”.');
      return;
    }
    if (state.autonomyRunning) {
      window.nexusAddMsg?.('assistant', 'Já existe um ciclo autônomo em execução.');
      return;
    }
    if (typeof window.nexusAsk !== 'function') {
      window.nexusAddMsg?.('assistant', 'O Agent Core ainda está inicializando. Tente novamente em alguns segundos.');
      return;
    }

    const context = window.nexusSessionContext?.get?.() || {};
    const projectName = context.name || 'Nexus';
    const projectKey = context.key || 'nexus';
    const repository = context.repository || 'giva-norberto/nexus';

    state.autonomyRunning = true;
    const button = [...document.querySelectorAll('header .btn')].find((item) => /executar ciclo seguro/i.test(item.textContent));
    const previousLabel = button?.textContent || 'Executar ciclo seguro';
    if (button) {
      button.disabled = true;
      button.textContent = 'Investigando...';
    }

    window.nexusAddMsg?.('assistant', `Iniciando ciclo autônomo seguro no projeto ${projectName}. Nesta versão, o ciclo é somente leitura.`);

    const autonomyPrompt = [
      `No projeto ${projectName} (${projectKey}), repositório ${repository}, execute um ciclo autônomo seguro SOMENTE LEITURA.`,
      'Objetivo: observar o estado atual, investigar evidências disponíveis, identificar no máximo três riscos ou pendências reais e priorizar a próxima ação com maior valor.',
      'Use as ferramentas disponíveis do Nexus quando forem necessárias.',
      'Não invente arquivos, dados, deploys, merges, PRs ou alterações.',
      'Não altere produção, Firestore, Storage, Rules, IAM ou permissões.',
      'Não acione alternativa paga.',
      'Classifique cada conclusão como CONFIRMADO, PROVÁVEL, NÃO VERIFICADO ou RECOMENDAÇÃO.',
      'Ao final, diga explicitamente: (1) o que foi apenas observado, (2) o que recomenda fazer em seguida e (3) se a próxima etapa exigiria aprovação humana.'
    ].join('\n');

    try {
      const result = await window.nexusAsk(autonomyPrompt);
      window.nexusAddMsg?.('assistant', result?.answer || 'O ciclo autônomo terminou sem resposta do Agent Core.');
    } catch (error) {
      console.error('Nexus autonomy cycle failed', error);
      window.nexusAddMsg?.('assistant', error?.message || 'Não consegui concluir o ciclo autônomo seguro.');
    } finally {
      state.autonomyRunning = false;
      if (button) {
        button.disabled = false;
        button.textContent = previousLabel;
      }
    }
  }

  function observeAssistantMessages() {
    const feed = document.getElementById('feed');
    if (!feed || feed.dataset.voiceObserved === 'true') return;
    feed.dataset.voiceObserved = 'true';

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (!node.classList.contains('msg') || node.classList.contains('user')) continue;
          const bubble = node.querySelector('.bubble');
          if (!bubble || bubble.dataset.voiceRead === 'true') continue;
          bubble.dataset.voiceRead = 'true';
          speak(bubble.textContent || '');
        }
      }
    });
    observer.observe(feed, { childList: true });
  }

  function installMobileRecovery() {
    if (!hasSpeechSynthesis) return;
    const resume = () => {
      if (!state.audioUnlocked || !state.voiceEnabled) return;
      try {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      } catch (_) {}
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setTimeout(resume, 120);
    });
    window.addEventListener('pageshow', () => setTimeout(resume, 120));
    window.addEventListener('focus', () => setTimeout(resume, 120));
    if ('onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.addEventListener?.('voiceschanged', () => {
        if (state.speechQueue.length && !window.speechSynthesis.speaking) {
          playNextSpeech(state.speechGeneration);
        }
      });
    }
  }

  function init() {
    ensureVoiceControls();
    ensureSidebarControls();
    updateGovernanceDisplay();
    observeAssistantMessages();
    installMobileRecovery();
    window.runAutonomy = runAutonomy;
    window.nexusVoice = {
      speak,
      start: startListening,
      stop: stopListening,
      unlock: unlockAudio,
      test: testAudio,
      stopSpeaking,
      getState: () => ({ ...state, recognition: undefined, activeUtterance: undefined, speechQueue: [...state.speechQueue] })
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
