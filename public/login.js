// Login page logic

async function checkAuthStatus() {
  const r = await fetch('/api/auth/status');
  const data = await r.json();

  document.getElementById('loading').classList.add('hidden');

  if (data.enabled) {
    // Auth enabled — show login form
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('login-subtitle').textContent = 'Enter password to access';
  } else {
    // No auth — show setup form (first time)
    document.getElementById('setup-form').classList.remove('hidden');
    document.getElementById('login-subtitle').textContent = 'Set up password to secure your panel';
  }
}

// ─── Login ───

document.getElementById('login-btn').addEventListener('click', async () => {
  const password = document.getElementById('login-password').value;
  if (!password) return;

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Verifying...';

  const r = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await r.json();

  if (data.status === 'ok') {
    window.location.href = '/';
  } else {
    const err = document.getElementById('login-error');
    err.textContent = data.error || 'Login failed';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '🔓 Login';
  }
});

document.getElementById('login-password').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

// ─── Setup (first time) ───

document.getElementById('setup-btn').addEventListener('click', async () => {
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-confirm').value;
  const err = document.getElementById('setup-error');

  if (password.length < 1) {
    err.textContent = 'Password must be at least 1 character';
    err.classList.remove('hidden');
    return;
  }
  if (password !== confirm) {
    err.textContent = 'Passwords do not match';
    err.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('setup-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Setting up...';

  const r = await fetch('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await r.json();

  if (data.status === 'ok') {
    window.location.href = '/';
  } else {
    err.textContent = data.error || 'Setup failed';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '🔐 Set Password';
  }
});

// ─── Init ───

checkAuthStatus();
