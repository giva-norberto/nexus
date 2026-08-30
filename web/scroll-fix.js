// Rolagem automática, layout responsivo e formatação segura do chat Nexus.
function nexusEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;'
  }[char] || char));
}

function formatBubble(raw) {
  const lines = nexusEscapeHtml(raw).split('\n');
  const html = [];
  let listType = null;

  const closeList = () => {
    if (!listType) return;
    html.push(listType === 'ol' ? '</ol>' : '</ul>');
    listType = null;
  };

  const inline = (value) => String(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);

    if (heading) {
      closeList();
      html.push(`<strong class="bubble-h">${inline(heading[2])}</strong>`);
      continue;
    }

    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }

    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    closeList();
    if (line.trim() === '') html.push('<br>');
    else html.push(`<div>${inline(line)}</div>`);
  }

  closeList();
  return html.join('');
}

window.formatBubble = formatBubble;

function formatAssistantBubbles(root = document) {
  const scope = root?.querySelectorAll ? root : document;
  scope.querySelectorAll('.msg.assistant .bubble:not([data-markdown-formatted])').forEach((bubble) => {
    const text = bubble.textContent || '';
    bubble.setAttribute('data-markdown-formatted', '1');
    bubble.innerHTML = formatBubble(text);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const feed = document.getElementById('feed');
  const main = document.querySelector('main');
  const composer = document.getElementById('composer');
  const input = document.getElementById('input');
  const aside = document.querySelector('aside');
  if (!feed || !main || !composer) return;

  const style = document.createElement('style');
  style.textContent = `
    :root{--nexus-vh:100dvh}
    html,body{height:100%;max-height:100%;overflow:hidden!important}
    body{overscroll-behavior:none}
    #app{height:var(--nexus-vh)!important;min-height:0!important;overflow:hidden!important}
    main{height:var(--nexus-vh)!important;min-height:0!important;overflow:hidden!important;display:flex!important;flex-direction:column!important}
    header{flex:0 0 auto!important;position:relative!important;top:auto!important}
    #feed{flex:1 1 0!important;min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;overscroll-behavior:contain;scroll-behavior:auto!important;-webkit-overflow-scrolling:touch}
    #composer{flex:0 0 auto!important;position:relative!important;bottom:auto!important;z-index:3}
    #input{font-size:16px}
    .msg.assistant .bubble{white-space:normal!important}
    .msg.assistant .bubble>div{white-space:pre-wrap}
    .msg.assistant .bubble .bubble-h{display:block;margin:.35em 0 .15em;font-size:1.03em}
    .msg.assistant .bubble ul,.msg.assistant .bubble ol{margin:.35em 0 .35em 1.4em;padding:0}
    .msg.assistant .bubble li{margin:.15em 0}
    .msg.assistant .bubble code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:5px;padding:1px 4px}
    @media(max-width:760px){
      #app,main{height:var(--nexus-vh)!important}
      header{min-height:52px!important;padding:8px 9px!important;overflow-x:auto!important;scrollbar-width:none}
      header::-webkit-scrollbar{display:none}
      #feed{padding:12px 9px 12px!important;gap:11px!important}
      .msg{max-width:98%!important;gap:7px!important}
      .avatar{width:26px!important;height:26px!important;flex-basis:26px!important;font-size:9px!important}
      .bubble{padding:10px 11px!important;border-radius:11px!important}
      #composer{padding:8px max(8px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))!important;gap:7px!important}
      #input{min-height:46px!important;max-height:34vh!important;line-height:1.35!important;padding:11px 12px!important}
      #sendBtn{min-width:66px!important;min-height:46px!important;padding:8px 11px!important}
      .btn{min-height:42px}
      aside{width:100vw!important;max-width:100vw!important;height:var(--nexus-vh)!important;max-height:var(--nexus-vh)!important;padding-bottom:env(safe-area-inset-bottom)!important}
      .modal{padding:10px!important}
      .modal .box{width:100%!important;max-height:calc(var(--nexus-vh) - 20px)!important}
    }
  `;
  document.head.appendChild(style);

  const setViewportHeight = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--nexus-vh', `${Math.round(height)}px`);
  };

  let scrollTimers = [];
  const cancelScrollTimers = () => {
    scrollTimers.forEach(clearTimeout);
    scrollTimers = [];
  };

  const goBottomNow = () => {
    feed.scrollTop = feed.scrollHeight;
  };

  const settleAtBottom = () => {
    cancelScrollTimers();
    goBottomNow();
    requestAnimationFrame(() => {
      goBottomNow();
      requestAnimationFrame(goBottomNow);
    });
    [40, 120, 260, 520].forEach((delay) => {
      scrollTimers.push(setTimeout(goBottomNow, delay));
    });
  };

  window.nexusScrollToBottom = settleAtBottom;

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) =>
      mutation.type === 'characterData' || mutation.addedNodes.length > 0
    );
    if (!relevant) return;
    formatAssistantBubbles(feed);
    settleAtBottom();
  });
  observer.observe(feed, { childList: true, subtree: true, characterData: true });

  const resizeObserver = new ResizeObserver(() => settleAtBottom());
  resizeObserver.observe(feed);
  resizeObserver.observe(composer);

  composer.addEventListener('submit', () => {
    setTimeout(settleAtBottom, 0);
  }, true);

  if (input) {
    const resizeInput = () => {
      input.style.height = 'auto';
      const max = Math.max(150, Math.floor((window.visualViewport?.height || window.innerHeight) * 0.34));
      input.style.height = `${Math.min(input.scrollHeight, max)}px`;
      settleAtBottom();
    };
    input.addEventListener('input', resizeInput);
    input.addEventListener('focus', () => setTimeout(settleAtBottom, 120));
    input.addEventListener('blur', () => setTimeout(settleAtBottom, 80));
  }

  window.addEventListener('resize', () => {
    setViewportHeight();
    settleAtBottom();
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      setViewportHeight();
      settleAtBottom();
    });
    window.visualViewport.addEventListener('scroll', settleAtBottom);
  }

  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      setViewportHeight();
      settleAtBottom();
    }, 180);
  });

  setViewportHeight();
  formatAssistantBubbles(feed);
  settleAtBottom();
});

function loadOptionalNexusScript(src, dataKey, dataValue) {
  if (document.querySelector(`script[${dataKey}]`)) return;
  const script = document.createElement('script');
  script.src = src;
  script.setAttribute(dataKey, dataValue);
  document.head.appendChild(script);
}

// Camadas opcionais desacopladas do layout principal.
loadOptionalNexusScript('./voice-autonomy.js', 'data-nexus-voice-autonomy', 'v1');
loadOptionalNexusScript('./source-map-ui.js', 'data-nexus-source-map-ui', 'v1');