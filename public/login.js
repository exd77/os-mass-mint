// Login page logic

async function checkAuthStatus() {
  const r = await fetch('/api/auth/status');
  const data = await r.json();

  document.getElementById('loading').classList.add('hidden');

  if (data.enabled) {
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('login-subtitle').textContent = '// authenticate to continue';
  } else {
    document.getElementById('setup-form').classList.remove('hidden');
    document.getElementById('login-subtitle').textContent = '// initial setup required';
  }
}

// ─── Login ───

document.getElementById('login-btn').addEventListener('click', async () => {
  const password = document.getElementById('login-password').value;
  if (!password) return;

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Verifying...';

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
    btn.textContent = 'Enter';
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
  btn.textContent = 'Setting up...';

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
    btn.textContent = 'Set Password';
  }
});

document.getElementById('setup-password').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('setup-confirm').focus();
});

document.getElementById('setup-confirm').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('setup-btn').click();
});

// ─── Init ───

checkAuthStatus();
