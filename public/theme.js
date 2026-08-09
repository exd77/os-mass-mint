// Shared dark/light theme controller.
(() => {
  const STORAGE_KEY = 'rusminter-theme';
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function currentTheme() {
    return root.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function updateControls() {
    const theme = currentTheme();
    const next = theme === 'dark' ? 'light' : 'dark';

    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.setAttribute('aria-label', `Switch to ${next} mode`);
      button.setAttribute('title', `Switch to ${next} mode`);
      button.setAttribute('aria-pressed', String(theme === 'light'));
    });

    if (themeColor) {
      themeColor.setAttribute('content', theme === 'light' ? '#F7F7FA' : '#09090B');
    }
  }

  function setTheme(theme, persist = true) {
    const safeTheme = theme === 'light' ? 'light' : 'dark';
    root.dataset.theme = safeTheme;
    root.style.colorScheme = safeTheme;

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, safeTheme);
      } catch (_) {
        // Storage can be unavailable in hardened/private browser modes.
      }
    }

    updateControls();
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTheme(currentTheme(), false);

    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
    });
  });

  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY && (event.newValue === 'light' || event.newValue === 'dark')) {
      setTheme(event.newValue, false);
    }
  });
})();
