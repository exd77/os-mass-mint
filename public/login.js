// RUSMINTER login page interactions

function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function showError(containerId, inputIds, message = '') {
  const error = document.getElementById(containerId);
  if (!error) return;
  error.textContent = message;
  error.classList.toggle('hidden', !message);
  inputIds.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { error: `Unexpected server response (${response.status})` };
  }
}

async function checkAuthStatus() {
  const loading = document.getElementById('loading');
  const subtitle = document.getElementById('login-subtitle');

  try {
    const response = await fetch('/api/auth/status', { headers: { Accept: 'application/json' } });
    const data = await readJson(response);
    if (!response.ok || data.error) throw new Error(data.error || 'Unable to check access status');

    loading.classList.add('hidden');
    if (data.enabled) {
      document.getElementById('login-form').classList.remove('hidden');
      subtitle.textContent = 'Sign in to continue to your minting workspace.';
      requestAnimationFrame(() => document.getElementById('login-password')?.focus());
    } else {
      document.getElementById('setup-form').classList.remove('hidden');
      subtitle.textContent = 'Complete the initial security setup.';
      requestAnimationFrame(() => document.getElementById('setup-password')?.focus());
    }
  } catch (error) {
    loading.textContent = 'Unable to connect to the server.';
    loading.classList.add('error');
    subtitle.textContent = 'Check that the RUSMINTER service is running, then reload this page.';
  }
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const passwordInput = document.getElementById('login-password');
  const password = passwordInput.value;
  const button = document.getElementById('login-btn');

  showError('login-error', ['login-password']);
  if (!password) {
    showError('login-error', ['login-password'], 'Enter your password.');
    passwordInput.focus();
    return;
  }

  setBusy(button, true, 'Verifying…');
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await readJson(response);

    if (response.ok && data.status === 'ok') {
      window.location.href = '/';
      return;
    }

    showError('login-error', ['login-password'], data.error || 'The password is incorrect.');
    passwordInput.select();
  } catch (_) {
    showError('login-error', ['login-password'], 'The server could not be reached. Try again.');
  } finally {
    setBusy(button, false, 'Verifying…');
  }
});

document.getElementById('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const passwordInput = document.getElementById('setup-password');
  const confirmInput = document.getElementById('setup-confirm');
  const password = passwordInput.value;
  const confirm = confirmInput.value;
  const button = document.getElementById('setup-btn');

  showError('setup-error', ['setup-password', 'setup-confirm']);
  if (password.length < 8) {
    showError('setup-error', ['setup-password'], 'Use at least 8 characters.');
    passwordInput.focus();
    return;
  }
  if (password !== confirm) {
    showError('setup-error', ['setup-confirm'], 'The passwords do not match.');
    confirmInput.focus();
    return;
  }

  setBusy(button, true, 'Securing panel…');
  try {
    const response = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await readJson(response);

    if (response.ok && data.status === 'ok') {
      window.location.href = '/';
      return;
    }
    showError('setup-error', ['setup-password', 'setup-confirm'], data.error || 'Setup failed. Try again.');
  } catch (_) {
    showError('setup-error', ['setup-password', 'setup-confirm'], 'The server could not be reached. Try again.');
  } finally {
    setBusy(button, false, 'Securing panel…');
  }
});

document.querySelectorAll('[data-pw-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.getAttribute('data-pw-toggle'));
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    button.setAttribute('aria-pressed', String(show));
  });
});

document.querySelectorAll('[data-pw-strength]').forEach((bar) => {
  const input = document.getElementById(bar.getAttribute('data-pw-strength'));
  if (!input) return;
  input.addEventListener('input', () => {
    const length = input.value.length;
    bar.style.width = `${Math.min(100, length * 10)}%`;
    bar.dataset.level = length < 8 ? 'weak' : length < 12 ? 'medium' : 'strong';
  });
});

checkAuthStatus();
