// Ajuste de rolagem do chat do Nexus.
window.addEventListener('DOMContentLoaded', () => {
  const feed = document.getElementById('feed');
  const main = document.querySelector('main');
  const composer = document.getElementById('composer');
  if (!feed || !main) return;

  const style = document.createElement('style');
  style.textContent = `
    html,body{height:100%;overflow:hidden!important}
    #app{height:100dvh!important;min-height:0!important;overflow:hidden!important}
    main{height:100dvh!important;min-height:0!important;overflow:hidden!important}
    header{flex:0 0 auto!important}
    #feed{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;overscroll-behavior:contain;scroll-behavior:auto!important}
    #composer{flex:0 0 auto!important;position:relative!important;bottom:auto!important}
    @media(max-width:760px){#feed{padding-bottom:18px!important}}
  `;
  document.head.appendChild(style);

  let userReadingHistory = false;
  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;

  const goBottom = (force = false) => {
    if (!force && userReadingHistory) return;
    requestAnimationFrame(() => {
      feed.scrollTop = feed.scrollHeight;
      requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
    });
  };

  feed.addEventListener('scroll', () => {
    userReadingHistory = !nearBottom();
  }, { passive: true });

  const observer = new MutationObserver((mutations) => {
    const addedMessage = mutations.some((mutation) =>
      [...mutation.addedNodes].some((node) => node.nodeType === 1 && (node.matches?.('.msg') || node.querySelector?.('.msg')))
    );
    if (addedMessage) {
      userReadingHistory = false;
      goBottom(true);
    }
  });
  observer.observe(feed, { childList: true, subtree: true });

  if (composer) {
    composer.addEventListener('submit', () => {
      userReadingHistory = false;
      setTimeout(() => goBottom(true), 0);
    });
  }

  window.addEventListener('resize', () => goBottom(false));
  goBottom(true);
});
