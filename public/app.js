const $ = (id) => document.getElementById(id);
const dialogs = [...document.querySelectorAll('dialog')];
const roomPattern = /^[A-Z0-9]{6}$/;
const markLabels = { correct: 'right letter, right spot', present: 'right letter, different spot', absent: 'not in the word' };
let room = null;
let source = null;
let connected = false;
let streamHealthy = false;
let lastSnapshotAt = 0;
let pollInFlight = false;
let lastStateSignature = '';
let busy = false;
let draft = '';
let boardError = '';
let revision = 0;
let navigation = 0;
let clockOffset = 0;
let currentCode = '';
let loadingCount = 0;
let loaderInterval;
let noticeTimeout;
let lastBoard = '';
let lastPlayers = '';
let lastHistory = '';
let lastAnnouncement = '';

function savedName() {
  try { return localStorage.getItem('wordbloom-name') || ''; } catch { return ''; }
}
function rememberName(name) {
  try { localStorage.setItem('wordbloom-name', name); } catch { /* Private storage is optional. */ }
}
function showDialog(id) {
  const dialog = $(id);
  for (const other of dialogs) if (other !== dialog && other.open) other.close();
  if (!dialog.open) dialog.showModal();
}
function announce(message) {
  if (message === lastAnnouncement) return;
  lastAnnouncement = message;
  $('announcer').textContent = message;
}
function notice(message) {
  clearTimeout(noticeTimeout);
  $('notice-text').textContent = message;
  $('notice').hidden = false;
  noticeTimeout = setTimeout(() => { $('notice').hidden = true; }, 6500);
}
function loading(active, message = 'A little something is growing…') {
  loadingCount = Math.max(0, loadingCount + (active ? 1 : -1));
  $('loading').hidden = loadingCount === 0;
  if (active) {
    $('loading-text').textContent = message;
    (dialogs.find((dialog) => dialog.open) || document.body).append($('loading'));
  }
  if (loadingCount && !loaderInterval && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const frames = [' \\ | / \n -(@)- \n / | \\ \n   |   \n  \\|/  ', '  \\|/  \n --@-- \n  /|\\  \n   |   \n  \\|/  ', ' / | \\ \n -(@)- \n \\ | / \n   |   \n  \\|/  '];
    let frame = 0;
    loaderInterval = setInterval(() => { $('sunflower-loader').textContent = frames[++frame % frames.length]; }, 240);
  }
  if (!loadingCount) {
    clearInterval(loaderInterval);
    loaderInterval = null;
    document.body.append($('loading'));
  }
}
async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw Object.assign(new Error('The garden is offline for a moment. Check your connection and try again — your word has not been cleared.'), { offline: true });
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The garden sent an unexpected reply. Please try again in a moment.'); }
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something didn’t take root. Please try again.'), { status: response.status });
  return data;
}
function disconnect() {
  if (source) source.close();
  source = null;
  connected = false;
  streamHealthy = false;
  lastSnapshotAt = 0;
}
function updateConnection() {
  $('connection-status').classList.toggle('reconnecting', !connected);
  $('connection-text').textContent = connected ? (streamHealthy ? 'Live with your room' : 'Live · backup connection') : 'Reconnecting — guesses paused';
}
function connect(code) {
  disconnect();
  const stream = new EventSource(`/api/rooms/${code}/events`);
  source = stream;
  updateConnection();
  stream.addEventListener('state', (event) => {
    if (source !== stream || currentCode !== code) return;
    try {
      const state = JSON.parse(event.data);
      connected = true;
      streamHealthy = true;
      lastSnapshotAt = Date.now();
      applyState(state);
    } catch {
      connected = false;
      streamHealthy = false;
      renderControls();
      notice('We couldn’t read the room update. Reconnecting to your garden…');
      stream.close();
      if (source === stream) setTimeout(() => { if (source === stream) connect(code); }, 2000);
    }
  });
  stream.onerror = () => {
    if (source !== stream) return;
    streamHealthy = false;
    stream.close();
    source = null;
    connected = Date.now() - lastSnapshotAt <= 6000;
    renderControls();
  };
}
function setView(view) {
  $('home-view').hidden = view !== 'home';
  $('room-view').hidden = view !== 'room';
  $('offline-panel').hidden = view !== 'offline';
}
function goHome() {
  navigation++;
  disconnect();
  room = null;
  currentCode = '';
  draft = '';
  boardError = '';
  revision++;
  busy = false;
  for (const dialog of dialogs) if (dialog.open) dialog.close();
  history.pushState(null, '', '/');
  document.title = 'wordlle with Ishita — good words, better company.';
  setView('home');
  window.scrollTo({ top: 0 });
}
function enterRoom(state) {
  for (const dialog of dialogs) if (dialog.open) dialog.close();
  currentCode = state.code;
  history.replaceState(null, '', `/?room=${state.code}`);
  applyState(state);
  connect(state.code);
  renderControls();
}
function openJoin(code = '', description = '') {
  $('join-error').textContent = '';
  $('join-name').value = savedName();
  $('join-code').value = code;
  $('join-description').textContent = description || 'Have an invite? Enter your room code and make yourself at home.';
  showDialog('join-dialog');
}
async function restoreRoom() {
  const version = ++navigation;
  disconnect();
  room = null;
  draft = '';
  boardError = '';
  revision++;
  const rawCode = new URLSearchParams(location.search).get('room');
  currentCode = (rawCode || '').trim().toUpperCase();
  if (!rawCode) { setView('home'); return; }
  if (!roomPattern.test(currentCode)) {
    setView('home');
    openJoin('', 'That invite code doesn’t look quite right. Room codes have six letters or numbers.');
    return;
  }
  setView('offline');
  $('offline-heading').textContent = 'Finding your garden…';
  $('offline-description').textContent = 'We’re checking your room and saving you a place.';
  $('retry-button').disabled = true;
  loading(true, 'Finding your people…');
  try {
    const state = await api(`/api/rooms/${currentCode}`);
    if (version === navigation) enterRoom(state);
  } catch (error) {
    if (version !== navigation) return;
    if (error.status === 403 || error.status === 404) {
      setView('home');
      openJoin(currentCode, error.status === 404 ? 'That room is missing or has expired. Check the code with your host, or start a fresh room.' : 'You’re invited. Choose your name to join this room.');
      if (error.status === 404) $('join-error').textContent = 'Room not found. Your host can send you a fresh invite.';
    } else {
      setView('offline');
      $('offline-heading').textContent = 'The garden is resting.';
      $('offline-description').textContent = error.message;
    }
  } finally {
    $('retry-button').disabled = false;
    loading(false);
  }
}

function self() { return room?.players.find((player) => player.id === room.selfId); }
function isHost() { return room?.selfId === room?.hostId; }
function timeLeft() { return room?.deadline ? Math.max(0, Math.ceil((room.deadline - Date.now() - clockOffset) / 1000)) : 0; }
function canGuess() { return room?.status === 'playing' && self()?.status === 'playing' && connected && !busy && timeLeft() > 0; }
function applyState(state) {
  if (state.code !== currentCode) return;
  if (room?.code === state.code && state.serverTime < room.serverTime) return;
  const previous = room;
  clockOffset = state.serverTime - Date.now();
  const signature = JSON.stringify({ ...state, serverTime: 0 });
  if (previous && signature === lastStateSignature) {
    room = state;
    revision++;
    renderControls();
    tick();
    return;
  }
  lastStateSignature = signature;
  const newRound = !previous || previous.code !== state.code || previous.round !== state.round || (state.status === 'lobby' && previous.status !== 'lobby');
  const newGuess = !newRound && state.guesses.length > previous.guesses.length;
  if (newRound || newGuess || state.status !== 'playing') {
    draft = '';
    boardError = '';
  }
  room = state;
  revision++;
  document.title = state.status === 'lobby' ? `Room ${state.code} · wordlle with Ishita` : `Round ${state.round}/${state.totalRounds} · wordlle with Ishita`;
  setView('room');
  renderRoom();
  if (newRound && state.status === 'playing') announce(`Round ${state.round} of ${state.totalRounds}. Find a ${state.wordLength}-letter word. You have six guesses.`);
  else if (newGuess) {
    const guess = state.guesses.at(-1);
    announce(`${guess.word}: ${[...guess.word].map((letter, index) => `${letter}, ${markLabels[guess.marks[index]]}`).join('; ')}.`);
  } else if (previous && previous.status !== state.status && state.status !== 'playing') announce(state.status === 'finished' ? 'The game is finished. Final scores are ready.' : `Round complete. The word was ${state.answer}.`);
}
function renderRoom() {
  if (!room) return;
  const lobby = room.status === 'lobby';
  $('room-code').textContent = room.code;
  $('room-eyebrow').textContent = lobby ? 'Your private patch' : `${room.wordLength} letters · ${room.totalRounds} rounds · room ${room.code}`;
  $('room-title').textContent = lobby ? 'Room to bloom.' : room.status === 'finished' ? 'What a lovely word garden.' : `Round ${room.round} of ${room.totalRounds}`;
  $('lobby-panel').hidden = !lobby;
  $('play-panel').hidden = lobby;
  $('lobby-rounds').textContent = `${room.totalRounds} rounds`;
  $('lobby-length').textContent = `${room.wordLength}-letter words`;
  const host = room.players.find((player) => player.id === room.hostId);
  $('lobby-description').textContent = isHost() ? 'Invite your people, then start when you’re ready. Everyone gets the same word and their own board.' : `${host?.name || 'Your host'} will start when everyone is here. Settle in — there’s a good word on the way.`;
  $('lobby-note').textContent = isHost() ? 'Playing solo? You’re welcome to start now. New players can only join before the game begins.' : 'You’re in. Keep this tab open; the first round will appear here.';
  $('leaderboard-heading').textContent = room.status === 'finished' ? 'The final harvest' : lobby ? 'In the garden' : 'Growing together';
  $('leaderboard-description').textContent = lobby ? 'A little friendly competition.' : 'Your words are private. Your progress is shared.';
  renderPlayers();
  renderBoard();
  renderResult();
  renderHistory();
  renderControls();
  tick();
}
function renderPlayers() {
  const signature = JSON.stringify([room.players, room.hostId, room.selfId, room.status]);
  if (signature === lastPlayers) return;
  lastPlayers = signature;
  $('player-count').textContent = `${room.players.length} / ${room.maxPlayers}`;
  const players = [...room.players].sort((a, b) => b.score - a.score);
  $('player-list').replaceChildren(...players.map((player) => {
    const li = document.createElement('li');
    li.className = `player ${player.id === room.selfId ? 'self' : ''} ${player.status}`;
    const avatar = document.createElement('span');
    avatar.className = `avatar ${player.online ? 'online' : ''}`;
    avatar.textContent = [...player.name][0]?.toUpperCase() || '·';
    avatar.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div');
    info.className = 'player-info';
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player.name;
    const qualifier = document.createElement('small');
    qualifier.textContent = [player.id === room.selfId ? 'you' : '', player.id === room.hostId ? 'host' : ''].filter(Boolean).join(' · ');
    name.append(qualifier);
    const status = document.createElement('span');
    status.className = 'player-status';
    const progress = room.status === 'lobby' ? 'Ready to grow' : player.status === 'solved' ? `Solved · ${player.guessCount}/6 guesses` : player.status === 'out' ? `${player.guessCount}/6 guesses · finished` : room.status !== 'playing' ? `${player.guessCount}/6 guesses · round ended` : `${player.guessCount}/6 guesses planted`;
    status.textContent = `${progress}${player.online ? '' : ' · offline'}`;
    info.append(name, status);
    const score = document.createElement('span');
    score.className = 'player-score';
    score.textContent = String(player.score);
    const unit = document.createElement('small');
    unit.textContent = player.score === 1 ? 'pt' : 'pts';
    score.append(unit);
    score.setAttribute('aria-label', `${player.score} ${player.score === 1 ? 'point' : 'points'}`);
    li.append(avatar, info, score);
    return li;
  }));
}
function renderBoard() {
  if (!room) return;
  const signature = JSON.stringify([room.code, room.round, room.wordLength, room.guesses, draft]);
  if (signature === lastBoard) return;
  lastBoard = signature;
  $('board').style.setProperty('--letters', room.wordLength);
  $('board').style.width = `min(100%, ${room.wordLength * 49 + (room.wordLength - 1) * 6}px)`;
  $('board').setAttribute('aria-label', `Your guesses: six rows of ${room.wordLength} letters`);
  const rows = [];
  for (let index = 0; index < 6; index++) {
    const guess = room.guesses[index];
    const active = index === room.guesses.length;
    const word = guess?.word || (active ? draft : '');
    const row = document.createElement('div');
    row.className = 'board-row';
    row.style.gridTemplateColumns = `repeat(${room.wordLength}, 1fr)`;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', guess ? `Guess ${index + 1}: ${guess.word}` : `Guess ${index + 1}${active ? ', current' : ', empty'}`);
    for (let column = 0; column < room.wordLength; column++) {
      const tile = document.createElement('span');
      const mark = guess?.marks[column];
      tile.className = `tile${mark ? ` ${mark}` : word[column] ? ' filled' : ''}`;
      tile.textContent = word[column] || '';
      tile.setAttribute('aria-label', word[column] ? `${word[column]}${mark ? `, ${markLabels[mark]}` : ', not submitted'}` : 'Empty');
      row.append(tile);
    }
    rows.push(row);
  }
  $('board').replaceChildren(...rows);
  // Only fold the server's marks into keyboard colors; answers and scoring stay on the server.
  const ranks = { absent: 1, present: 2, correct: 3 };
  const marks = {};
  for (const guess of room.guesses) [...guess.word].forEach((letter, index) => {
    if ((ranks[guess.marks[index]] || 0) > (ranks[marks[letter]] || 0)) marks[letter] = guess.marks[index];
  });
  for (const key of $('keyboard').querySelectorAll('button')) {
    const letter = key.dataset.key;
    key.className = `key${letter.length > 1 ? ' wide' : ''}${marks[letter] ? ` ${marks[letter]}` : ''}`;
    key.setAttribute('aria-label', letter === 'ENTER' ? 'Submit guess' : letter === 'BACKSPACE' ? 'Delete last letter' : `${letter}${marks[letter] ? `, ${markLabels[marks[letter]]}` : ''}`);
  }
}
function renderResult() {
  const ended = room.status === 'round-over' || room.status === 'finished';
  $('round-result').hidden = !ended;
  if (!ended) return;
  const final = room.status === 'finished';
  $('result-label').textContent = final ? 'Every good garden deserves a celebration' : `Round ${room.round} · the word was`;
  if (final) {
    const best = Math.max(...room.players.map((player) => player.score));
    const winners = room.players.filter((player) => player.score === best);
    const names = winners.map((player) => player.id === room.selfId ? 'You' : player.name);
    $('result-heading').classList.remove('answer-word');
    $('result-heading').textContent = best === 0 ? 'A fresh start is always in season.' : `${names.join(' & ')} ${winners.length === 1 && winners[0].id !== room.selfId ? 'wins' : 'win'}!`;
    $('result-description').textContent = `The last word was ${room.answer}. ${best === 0 ? `${names.join(' & ')} ${winners.length > 1 ? 'tie' : 'finished'} at 0 points. Another round of growth?` : `${winners.length > 1 ? 'Tied at' : 'Finishing with'} ${best} ${best === 1 ? 'point' : 'points'}. A little company makes every word better.`}${isHost() ? '' : ' Waiting for your host to start a rematch.'}`;
  } else {
    $('result-heading').classList.add('answer-word');
    $('result-heading').textContent = room.answer;
    const solved = room.players.filter((player) => player.status === 'solved').length;
    $('result-description').textContent = `${solved} of ${room.players.length} ${room.players.length === 1 ? 'player found' : 'players found'} it.${isHost() ? ' Ready to plant the next word?' : ' Your host will start the next round.'}`;
  }
  $('next-button').textContent = final ? 'Play together again ↗' : `On to round ${room.round + 1} →`;
}
function renderHistory() {
  const signature = JSON.stringify(room.history);
  if (lastHistory === signature) return;
  lastHistory = signature;
  $('history-panel').hidden = room.history.length === 0;
  $('history-count').textContent = `(${room.history.length})`;
  $('history-list').replaceChildren(...room.history.map((round) => {
    const item = document.createElement('li');
    const answer = document.createElement('strong');
    answer.textContent = round.answer;
    item.append(`Round ${round.round} · `, answer, document.createElement('br'), `${round.solvers.length} ${round.solvers.length === 1 ? 'solve' : 'solves'}`);
    return item;
  }));
}
function renderControls() {
  if (!room) return;
  updateConnection();
  $('start-button').hidden = !isHost();
  $('start-button').disabled = busy || !connected;
  $('next-button').hidden = !isHost();
  $('next-button').disabled = busy || !connected;
  for (const key of $('keyboard').querySelectorAll('button')) key.disabled = !canGuess();
  renderBoardMessage();
}
function renderBoardMessage() {
  if (!room) return;
  const player = self();
  $('board-message').classList.toggle('error', Boolean(boardError));
  let message = `Find a ${room.wordLength}-letter word. Let your curiosity grow.`;
  if (boardError) message = boardError;
  else if (!connected) message = 'The connection is taking a breath. Your guesses are safe; typing resumes when we reconnect.';
  else if (room.status === 'finished') message = 'A whole garden of words. Thanks for growing together.';
  else if (room.status === 'round-over') message = 'One word down. A little wiser for the next.';
  else if (busy) message = 'Checking your word…';
  else if (player?.status === 'solved') message = 'You found it! One point planted. Let’s give the others room to bloom.';
  else if (player?.status === 'out') message = 'All six guesses planted. The word stays hidden until everyone finishes.';
  else if (room.status === 'playing' && timeLeft() === 0) message = 'Time’s up. Waiting for the round to settle…';
  $('board-message').textContent = message;
  $('board-caption').textContent = player?.status === 'solved' ? 'A little victory. Nicely grown.' : `${room.wordLength} letters · your private board`;
}
function tick() {
  if (!room || room.status === 'lobby') return;
  const seconds = timeLeft();
  $('timer').hidden = room.status !== 'playing';
  if (room.status !== 'playing') return;
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('timer-value').textContent = remaining;
  $('timer').setAttribute('aria-label', `Time remaining: ${Math.floor(seconds / 60)} minutes, ${seconds % 60} seconds`);
  $('timer').classList.toggle('urgent', seconds <= 30);
  if (seconds === 30) announce('Thirty seconds left in this round.');
  if (seconds === 0) renderControls();
}
async function submitGuess() {
  if (!canGuess()) return;
  if (draft.length !== room.wordLength) {
    boardError = `A little more to grow — use ${room.wordLength} letters.`;
    renderBoardMessage();
    announce(boardError);
    return;
  }
  const code = room.code;
  const round = room.round;
  const version = navigation;
  const startedAt = revision;
  const word = draft;
  busy = true;
  boardError = '';
  renderControls();
  loading(true, 'Let’s see what grows…');
  try {
    const state = await api(`/api/rooms/${code}/guess`, { word, round });
    // An SSE event can overtake this response, including a new round. Never rewind it.
    if (navigation === version && revision === startedAt && currentCode === code) applyState(state);
  } catch (error) {
    if (navigation === version && room?.code === code && room.round === round) {
      boardError = error.message;
      announce(error.message);
      if (error.status === 409) void resync(code, version);
    }
  } finally {
    if (navigation === version) { busy = false; renderControls(); }
    loading(false);
  }
}
async function resync(code, version) {
  const startedAt = revision;
  try {
    const state = await api(`/api/rooms/${code}`);
    if (version === navigation && startedAt === revision && code === currentCode) applyState(state);
  } catch (error) { if (version === navigation) notice(error.message); }
}
function typeKey(key) {
  if (!canGuess()) return;
  if (key === 'ENTER') { void submitGuess(); return; }
  if (key === 'BACKSPACE') draft = draft.slice(0, -1);
  else if (/^[A-Z]$/.test(key) && draft.length < room.wordLength) draft += key;
  else return;
  boardError = '';
  renderBoard();
  renderBoardMessage();
}
async function roomAction(action) {
  if (!room || busy || !connected || !isHost()) return;
  const code = room.code;
  const startedAt = revision;
  const version = navigation;
  busy = true;
  renderControls();
  loading(true, action === 'rematch' ? 'Making room for another bloom…' : 'Planting a new round…');
  try {
    const body = action === 'next' ? { round: room.round } : {};
    const state = await api(`/api/rooms/${code}/${action}`, body);
    if (version === navigation && startedAt === revision && code === currentCode) applyState(state);
  } catch (error) { if (version === navigation) notice(error.message); }
  finally {
    if (version === navigation) { busy = false; renderControls(); }
    loading(false);
  }
}
async function submitRoomForm(event, type) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting === 'true') return;
  const data = new FormData(form);
  const name = String(data.get('name')).trim();
  const errorNode = $(`${type}-error`);
  errorNode.textContent = '';
  if (!name) { errorNode.textContent = 'A name helps your people find you.'; return; }
  const code = type === 'join' ? String(data.get('code')).trim().toUpperCase() : '';
  if (type === 'join' && !roomPattern.test(code)) { errorNode.textContent = 'Room codes have six letters or numbers.'; return; }
  const version = navigation;
  const submit = form.querySelector('[type="submit"]');
  form.dataset.submitting = 'true';
  submit.disabled = true;
  loading(true, type === 'host' ? 'Planting your room…' : 'Finding your people…');
  try {
    const state = await api(type === 'host' ? '/api/rooms' : `/api/rooms/${code}/join`, type === 'host' ? { name, totalRounds: Number(data.get('rounds')), wordLength: Number(data.get('wordLength')) } : { name });
    if (version !== navigation) return;
    rememberName(name);
    enterRoom(state);
  } catch (error) {
    if (version === navigation) errorNode.textContent = error.message;
  } finally {
    delete form.dataset.submitting;
    submit.disabled = false;
    loading(false);
  }
}

for (const letters of ['QWERTYUIOP', 'ASDFGHJKL', ['ENTER', ...'ZXCVBNM', 'BACKSPACE']]) {
  const row = document.createElement('div');
  row.className = 'keyboard-row';
  for (const letter of letters) {
    const key = document.createElement('button');
    key.type = 'button';
    key.dataset.key = letter;
    key.className = `key${letter.length > 1 ? ' wide' : ''}`;
    key.textContent = letter === 'BACKSPACE' ? '⌫' : letter === 'ENTER' ? 'ENTER' : letter;
    key.setAttribute('aria-label', letter === 'BACKSPACE' ? 'Delete last letter' : letter === 'ENTER' ? 'Submit guess' : letter);
    row.append(key);
  }
  $('keyboard').append(row);
}
$('keyboard').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-key]');
  if (button) {
    typeKey(button.dataset.key);
    if (event.detail > 0) button.blur();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || dialogs.some((dialog) => dialog.open) || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  // Let Enter/Space activate a focused real button instead of also submitting a guess.
  if (event.target.closest('button,a,summary') && (event.key === 'Enter' || event.key === ' ')) return;
  const key = event.key.toUpperCase();
  if (!canGuess() || (!/^[A-Z]$/.test(key) && key !== 'ENTER' && key !== 'BACKSPACE')) return;
  event.preventDefault();
  if (!event.repeat || key === 'BACKSPACE') typeKey(key);
});
$('host-button').addEventListener('click', () => {
  $('host-name').value = savedName();
  $('host-error').textContent = '';
  showDialog('host-dialog');
});
$('join-button').addEventListener('click', () => openJoin());
$('rules-button').addEventListener('click', () => showDialog('rules-dialog'));
$('host-form').addEventListener('submit', (event) => void submitRoomForm(event, 'host'));
$('join-form').addEventListener('submit', (event) => void submitRoomForm(event, 'join'));
$('join-code').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase(); });
$('start-button').addEventListener('click', () => void roomAction('start'));
$('next-button').addEventListener('click', () => void roomAction(room?.status === 'finished' ? 'rematch' : 'next'));
$('home-button').addEventListener('click', goHome);
$('offline-home-button').addEventListener('click', goHome);
$('retry-button').addEventListener('click', () => void restoreRoom());
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
$('invite-button').addEventListener('click', () => {
  if (!room) return;
  $('share-code').textContent = room.code;
  $('invite-link').value = `${location.origin}/?room=${room.code}`;
  $('copy-status').textContent = '';
  $('invite-description').textContent = room.status === 'lobby' ? 'Send this link to your people, or share the room code.' : 'This game is already growing. Existing players can return with this link; new friends can join after a rematch.';
  showDialog('invite-dialog');
});
$('copy-button').addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText($('invite-link').value);
    $('copy-status').textContent = 'Copied. A little company is on its way.';
  } catch {
    $('invite-link').focus();
    $('invite-link').select();
    $('copy-status').textContent = 'Select and copy the link above, then send it to your people.';
  }
});
for (const dialog of dialogs) {
  dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.contains($('loading'))) document.body.append($('loading'));
  });
}
window.addEventListener('popstate', () => void restoreRoom());
window.addEventListener('online', () => {
  if (room && !connected) connect(room.code);
});
window.addEventListener('pagehide', disconnect);
window.addEventListener('pageshow', (event) => { if (event.persisted && room) { connect(room.code); renderControls(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
async function pollRoom() {
  if (!room || !currentCode || document.hidden || busy || pollInFlight || (streamHealthy && Date.now() - lastSnapshotAt < 10000)) return;
  const code = currentCode;
  const version = navigation;
  const startedAt = revision;
  pollInFlight = true;
  try {
    const state = await api(`/api/rooms/${code}`);
    if (version !== navigation || code !== currentCode || startedAt !== revision || busy) return;
    connected = true;
    lastSnapshotAt = Date.now();
    applyState(state);
  } catch {
    if (version === navigation && code === currentCode && Date.now() - lastSnapshotAt > 6000) {
      connected = false;
      renderControls();
    }
  } finally {
    pollInFlight = false;
  }
}
setInterval(() => void pollRoom(), 2500);
setInterval(tick, 250);
const welcomeTimer = setTimeout(() => $('welcome-dialog').close(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 900 : 3900);
$('welcome-dialog').addEventListener('close', () => { clearTimeout(welcomeTimer); void restoreRoom(); }, { once: true });
showDialog('welcome-dialog');
