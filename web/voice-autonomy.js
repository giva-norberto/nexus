// Nexus Voice + Autonomy v1
// Voz usa recursos nativos do navegador. Autonomia v1 executa ciclos reais de
// observação/investigação somente leitura pelo Agent Core existente.
(() => {
  const STORAGE = {
    voiceEnabled: 'nexusVoiceEnabled',
    autoSendVoice: 'nexusVoiceAutoSend',
    autonomyEnabled: 'nexusAutonomyEnabled'
  };

  const state = {
    listening: false,
    recognition: null,
    finalTranscript: '',
    autonomyRunning: false,
    voiceEnabled: localStorage.getItem(STORAGE.voiceEnabled) !== 'false',
    autoSendVoice: localStorage.getItem(STORAGE.autoSendVoice) !== 'false',
    autonomyEnabled: localStorage.getItem(STORAGE.autonomyEnabled) !== 'false'
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

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
      .slice(0, 3500);
  }

  function choosePortugueseVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    return voices.find((voice) => /^pt-BR$/i.test(voice.lang)) ||
      voices.find((voice) => /^pt[-_]/i.test(voice.lang)) ||
      null;
  }

  function speak(text) {
    if (!state.voiceEnabled || !('speechSynthesis' in window)) return;
    const cleaned = stripForSpeech(text);
    if (!cleaned) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleaned);
    utterance.lang = 'pt-BR';
    utterance.rate = 0.98;
    utterance.pitch = 1;
    const voice = choosePortugueseVoice();
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
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
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
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
        setTimeout(() => document.getElementById('composer')?.requestSubmit(), 80);
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
      if (/^v0\.7$/i.test(badge.textContent.trim())) badge.textContent = 'v0.8';
    });
  }

  function ensureVoiceControls() {
    const composer = document.getElementById('composer');
    const sendButton = document.getElementById('sendBtn');
    if (!composer || !sendButton || document.getElementById('nexusMicBtn')) return;

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
      <div class="t">Nexus Voice + Autonomy v1</div>
      <div class="s">Voz pelo navegador e ciclo autônomo real de investigação, somente leitura.</div>
    `;

    card.appendChild(createSwitch('nexusVoiceToggle', 'Responder com voz', state.voiceEnabled, (checked) => {
      state.voiceEnabled = checked;
      localStorage.setItem(STORAGE.voiceEnabled, String(checked));
      if (!checked && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    }));

    card.appendChild(createSwitch('nexusAutoSendVoiceToggle', 'Enviar ao terminar de falar', state.autoSendVoice, (checked) => {
      state.autoSendVoice = checked;
      localStorage.setItem(STORAGE.autoSendVoice, String(checked));
    }));

    card.appendChild(createSwitch('nexusAutonomyToggle', 'Autonomia segura', state.autonomyEnabled, (checked) => {
      state.autonomyEnabled = checked;
      localStorage.setItem(STORAGE.autonomyEnabled, String(checked));
    }));

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

  function init() {
    ensureVoiceControls();
    ensureSidebarControls();
    updateGovernanceDisplay();
    observeAssistantMessages();
    window.runAutonomy = runAutonomy;
    window.nexusVoice = {
      speak,
      start: startListening,
      stop: stopListening,
      getState: () => ({ ...state, recognition: undefined })
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
