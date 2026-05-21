// WhatTheSub — main game controller

let puzzle = null;
let gameState = null;
let date = null;

document.addEventListener('DOMContentLoaded', init);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  date = new Date().toISOString().slice(0, 10);
  renderDateHeader();

  const saved = Storage.getGame(date);

  if (saved && saved.status !== 'playing') {
    // Already completed today — show results
    gameState = saved;
    renderCompletedShell();
    try {
      const reveal = await API.revealAnswers(date);
      openEndModal(saved.status === 'won', reveal);
    } catch {
      openEndModal(saved.status === 'won', null);
    }
    return;
  }

  try {
    puzzle = await API.fetchPuzzle();
    date = puzzle.date; // use server date to handle UTC midnight edge cases

    gameState = saved ?? Storage.initGame(date, puzzle);
    Storage.saveGame(date, gameState);
    renderGame();
  } catch (err) {
    showError(err.message);
  }
}

function renderDateHeader() {
  const el = document.getElementById('today-date');
  if (el) {
    el.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderGame() {
  const round = gameState.current_round;
  if (round >= 6) { finishWin(); return; }

  const post = puzzle.rounds[round];
  const container = document.getElementById('game-container');

  container.innerHTML = `
    <div class="rounds-progress">
      ${Array.from({ length: 6 }, (_, i) => {
        const cls = i < round ? 'complete' : i === round ? 'active' : '';
        return `<div class="round-pip ${cls}" title="Round ${i + 1}"></div>`;
      }).join('')}
    </div>
    <p class="round-indicator">Round <strong>${round + 1}</strong> of 6</p>
    <div class="post-card">
      <p class="post-label">From somewhere on Reddit…</p>
      <h2 class="post-title">${escapeHtml(post.post_title)}</h2>
      <a class="post-source-link" href="${post.post_url}" target="_blank" rel="noopener noreferrer">
        View original ↗
      </a>
    </div>
    <p class="guess-prompt">Which subreddit did this come from?</p>
    <div class="options-grid" id="options"></div>
  `;

  syncStrikes();
  renderOptions();
}

function renderOptions() {
  const el = document.getElementById('options');
  if (!el) return;
  el.innerHTML = '';

  const wrongThisRound = gameState.rounds[gameState.current_round]?.guesses ?? [];

  gameState.remaining_options.forEach(sub => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerHTML = `<strong>r/</strong>${escapeHtml(sub)}`;
    btn.dataset.subreddit = sub;

    if (wrongThisRound.includes(sub)) {
      btn.classList.add('eliminated');
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => onGuess(sub));
    }

    el.appendChild(btn);
  });
}

function renderCompletedShell() {
  const container = document.getElementById('game-container');
  container.innerHTML = `
    <p class="round-indicator" style="margin-top:2rem; text-align:center;">You've already played today.</p>
    <p style="text-align:center; color:var(--muted); font-style:italic; margin-top:0.5rem;">
      Come back tomorrow for a new puzzle.
    </p>
  `;
  syncStrikes();
}

function syncStrikes() {
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`strike-${i}`);
    if (dot) dot.classList.toggle('used', i < (gameState?.strikes ?? 0));
  }
}

function showError(msg) {
  document.getElementById('game-container').innerHTML = `
    <div class="error-card" style="margin-top:1.5rem;">
      <p>Couldn't load today's puzzle.</p>
      <small>${escapeHtml(msg)}</small>
    </div>
  `;
}

// ─── Guess flow ───────────────────────────────────────────────────────────────

async function onGuess(guess) {
  lockOptions();

  let result;
  try {
    result = await API.submitGuess(date, gameState.current_round, guess);
  } catch (err) {
    console.error('Guess API error:', err);
    unlockOptions();
    return;
  }

  const roundIdx = gameState.current_round;

  if (result.correct) {
    flashCorrect(guess, () => {
      gameState.rounds[roundIdx].status = 'correct';
      gameState.rounds[roundIdx].correct_subreddit = guess;
      gameState.remaining_options = gameState.remaining_options.filter(o => o !== guess);
      gameState.current_round = roundIdx + 1;
      Storage.saveGame(date, gameState);

      if (gameState.current_round >= 6) finishWin();
      else renderGame();
    });
  } else {
    flashWrong(guess, () => {
      if (!gameState.rounds[roundIdx].guesses.includes(guess)) {
        gameState.rounds[roundIdx].guesses.push(guess);
        gameState.strikes += 1;
      }
      Storage.saveGame(date, gameState);
      syncStrikes();

      if (gameState.strikes >= gameState.max_strikes) {
        finishLoss();
      } else {
        markEliminated(guess);
        unlockOptions();
      }
    });
  }
}

// ─── Game over ────────────────────────────────────────────────────────────────

async function finishWin() {
  gameState.status = 'won';
  gameState.completed_at = new Date().toISOString();
  Storage.saveGame(date, gameState);
  Storage.updateStatsAfterGame(gameState);

  try {
    openEndModal(true, await API.revealAnswers(date));
  } catch {
    openEndModal(true, null);
  }
}

async function finishLoss() {
  gameState.status = 'lost';
  gameState.completed_at = new Date().toISOString();
  gameState.rounds.forEach(r => { if (r.status === 'pending') r.status = 'skipped'; });
  Storage.saveGame(date, gameState);
  Storage.updateStatsAfterGame(gameState);

  try {
    openEndModal(false, await API.revealAnswers(date));
  } catch {
    openEndModal(false, null);
  }
}

function openEndModal(won, reveal) {
  document.getElementById('end-title').textContent = won ? 'You got it!' : 'Game Over';
  document.getElementById('end-message').textContent = won
    ? `Completed with ${gameState.strikes} strike${gameState.strikes !== 1 ? 's' : ''}`
    : 'Better luck tomorrow';

  document.getElementById('share-card').textContent = buildShareText(won);

  if (reveal?.answers) {
    document.getElementById('answers-reveal').innerHTML = reveal.answers.map((a, i) => {
      const r = gameState.rounds[i];
      const ok = r?.status === 'correct';
      const attempts = r?.guesses?.length ?? 0;
      return `
        <div class="answer-row ${ok ? 'correct' : 'incorrect'}">
          <span class="round-num">${i + 1}</span>
          <a href="${a.post_url}" target="_blank" rel="noopener">r/${escapeHtml(a.subreddit)}</a>
          <span class="result-icon" title="${ok ? 'Correct' : `Wrong — ${attempts} bad guess${attempts !== 1 ? 'es' : ''}`}">
            ${ok ? '✓' : '✗'}
          </span>
        </div>`;
    }).join('');
  }

  document.getElementById('end-modal').classList.add('visible');
}

function buildShareText(won) {
  const d = new Date(date + 'T12:00:00Z');
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines = [`WhatTheSub · ${dateStr}`, ''];

  gameState.rounds.forEach(r => {
    lines.push((r.guesses ?? []).map(() => '🟥').join('') + (r.status === 'correct' ? '🟩' : '✗'));
  });

  lines.push('', `Strikes: ${gameState.strikes}/3`);

  if (won && gameState.completed_at && gameState.started_at) {
    const secs = Math.round((new Date(gameState.completed_at) - new Date(gameState.started_at)) / 1000);
    lines.push(`Time: ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
  }

  lines.push('whatthesub.pages.dev');
  return lines.join('\n');
}

// ─── Animations ───────────────────────────────────────────────────────────────

function flashCorrect(sub, cb) {
  const btn = document.querySelector(`[data-subreddit="${CSS.escape(sub)}"]`);
  if (btn) { btn.classList.add('correct'); btn.disabled = true; }
  setTimeout(cb, 900);
}

function flashWrong(sub, cb) {
  const btn = document.querySelector(`[data-subreddit="${CSS.escape(sub)}"]`);
  if (btn) {
    btn.classList.add('wrong');
    setTimeout(() => { btn.classList.remove('wrong'); cb(); }, 500);
  } else {
    cb();
  }
}

function markEliminated(sub) {
  const btn = document.querySelector(`[data-subreddit="${CSS.escape(sub)}"]`);
  if (btn) { btn.classList.add('eliminated'); btn.disabled = true; }
}

function lockOptions() {
  document.querySelectorAll('.option-btn:not(.eliminated)').forEach(b => { b.disabled = true; });
}

function unlockOptions() {
  document.querySelectorAll('.option-btn:not(.eliminated):not(.correct)').forEach(b => { b.disabled = false; });
}

// ─── Clipboard ────────────────────────────────────────────────────────────────

document.addEventListener('click', e => {
  if (e.target.id !== 'copy-btn') return;
  const text = document.getElementById('share-card').textContent;
  navigator.clipboard.writeText(text).then(() => {
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = 'Copy to Clipboard'; }, 2000);
  });
});

// ─── Util ─────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
