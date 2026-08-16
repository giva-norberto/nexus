window.NEXUS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyB3UZlfxP1qJ5JWQGy7FFl9AahISojaSGM",
  authDomain: "nexus-da920.firebaseapp.com",
  projectId: "nexus-da920",
  storageBucket: "nexus-da920.firebasestorage.app",
  messagingSenderId: "288616302811",
  appId: "1:288616302811:web:6febc7951de9fb00eae4fe",
  measurementId: "G-G70PRJCF6W"
};

// Mantém a conversa acompanhando automaticamente a mensagem mais recente.
window.addEventListener('DOMContentLoaded', () => {
  const feed = document.getElementById('feed');
  if (!feed) return;

  const scrollToLatest = () => {
    requestAnimationFrame(() => {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
    });
  };

  const observer = new MutationObserver(scrollToLatest);
  observer.observe(feed, { childList: true, subtree: true, characterData: true });
  scrollToLatest();
});
