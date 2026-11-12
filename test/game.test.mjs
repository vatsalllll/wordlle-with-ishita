import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer, scoreGuess } from '../server.mjs';

const wrongWords = ['CRANE', 'SLATE', 'BRICK', 'MOUND', 'GHOST', 'FJORD'];
const allowedWords = new Set(['APPLE', ...wrongWords]);

async function game(t, { persistent = false, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wordbloom-test-'));
  const settings = {
    dbPath: persistent ? join(directory, 'game.sqlite') : ':memory:',
    answers: ['APPLE'], allowedWords, guessCooldownMs: 0,
    now: () => 1_800_000_000_000, ...options,
  };
  let app;
  let base;
  async function start() {
    app = createGameServer(settings);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  t.after(async () => {
    try { await app?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await start();
  return {
    get base() { return base; },
    async restart() { await app.close(); app = undefined; await start(); },
    client(initialCookie = '') {
      let cookie = initialCookie;
      async function request(path, method = 'GET', body, headers = {}) {
        const response = await fetch(base + path, {
          method,
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        const session = response.headers.getSetCookie().find(value => value.startsWith('wb_session='));
        if (session) cookie = session.split(';')[0];
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: response.status, headers: response.headers, data };
      }
      return {
        get cookie() { return cookie; }, request,
        get: path => request(path),
        post: (path, body = {}, headers) => request(path, 'POST', body, headers),
      };
    },
  };
}

function ok(result) {
  assert.ok(result.status >= 200 && result.status < 300,
    `Expected success, got ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}
function denied(result, statuses) {
  if (statuses) assert.ok(statuses.includes(result.status), `Unexpected rejection status ${result.status}`);
  else assert.ok(result.status >= 400 && result.status < 500, `Expected rejection, got ${result.status}`);
}
const me = state => state.players.find(player => player.id === state.selfId);
const roomPath = code => `/api/rooms/${code}`;
async function create(host, name = 'Host') {
  return ok(await host.post('/api/rooms', { name, totalRounds: 3 }));
}
async function pair(t, options) {
  const server = await game(t, options);
  const host = server.client();
  const guest = server.client();
  const lobby = await create(host);
  const path = roomPath(lobby.code);
  ok(await guest.post(`${path}/join`, { name: 'Guest' }));
  return { server, host, guest, path, lobby };
}

// Every word is injected: these tests never depend on the production dictionary or randomness.
test('duplicate letters consume only unmatched answer letters', () => {
  const cases = [
    ['APPLE', 'APPLE', ['correct', 'correct', 'correct', 'correct', 'correct']],
    ['ALLEY', 'APPLE', ['correct', 'present', 'absent', 'present', 'absent']],
    ['PAPAL', 'APPLE', ['present', 'present', 'correct', 'absent', 'present']],
    ['EEEEE', 'APPLE', ['absent', 'absent', 'absent', 'absent', 'correct']],
    ['EERIE', 'SHEEP', ['present', 'present', 'absent', 'absent', 'absent']],
    ['LLAMA', 'APPLE', ['present', 'absent', 'present', 'absent', 'absent']],
  ];
  for (const [guess, answer, marks] of cases) assert.deepEqual(scoreGuess(guess, answer), marks);
});

test('room authority belongs to members and only the host controls the game', async t => {
  const { server, host, guest, path, lobby } = await pair(t);
  const anonymous = server.client();
  const outsider = server.client();
  await create(outsider, 'Outsider');
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.round, 0);
  assert.equal(lobby.answer, null);
  assert.match(lobby.code, /^[A-Z0-9]{6}$/);
  assert.equal(lobby.selfId, lobby.hostId);
  for (const client of [anonymous, outsider]) {
    denied(await client.get(path), [403, 404]);
    denied(await client.post(`${path}/start`), [403, 404]);
    denied(await client.post(`${path}/guess`, { word: 'APPLE', round: 1 }), [403, 404]);
  }
  for (const action of ['start', 'next', 'rematch']) {
    denied(await guest.post(`${path}/${action}`, { round: 1 }), [403]);
  }
  denied(await host.post(`${path}/guess`, { word: 'APPLE', round: 0 }));
  const playing = ok(await host.post(`${path}/start`));
  assert.equal(playing.status, 'playing');
  assert.equal(playing.round, 1);
  denied(await host.post(`${path}/start`));
  denied(await host.post(`${path}/next`, { round: 1 }));
  denied(await host.post(`${path}/rematch`));
  denied(await server.client().post(`${path}/join`, { name: 'Latecomer' }));
  assert.equal(ok(await host.get(path)).players.length, 2);
  denied(await host.get('/api/rooms/ZZZZZZ'), [404]);
});

test('invalid dictionary guesses cost no attempt and opponents never see guesses', async t => {
  const { host, guest, path } = await pair(t);
  const initial = ok(await host.post(`${path}/start`));
  assert.equal(initial.answer, null);
  assert.deepEqual(initial.history, []);
  assert.ok(!JSON.stringify(initial).includes('APPLE'));
  for (const word of ['ZZZZZ', 'FOUR', '<img>']) {
    denied(await host.post(`${path}/guess`, { word, round: 1 }));
  }
  const untouched = ok(await host.get(path));
  assert.equal(me(untouched).guessCount, 0);
  assert.deepEqual(untouched.guesses, []);
  const own = ok(await host.post(`${path}/guess`, { word: 'CRANE', round: 1 }));
  assert.equal(own.guesses[0].word, 'CRANE');
  assert.deepEqual(own.guesses[0].marks, scoreGuess('CRANE', 'APPLE'));
  const opponent = ok(await guest.get(path));
  assert.equal(opponent.players.find(player => player.id === own.selfId).guessCount, 1);
  assert.deepEqual(opponent.guesses, []);
  assert.equal(opponent.answer, null);
  assert.ok(!JSON.stringify(opponent).includes('CRANE'));
  assert.ok(!JSON.stringify(opponent).includes('APPLE'));
});

test('six attempts exhaust a player without revealing the answer early', async t => {
  const { host, guest, path } = await pair(t);
  ok(await host.post(`${path}/start`));
  let state;
  for (const word of wrongWords) state = ok(await host.post(`${path}/guess`, { word, round: 1 }));
  assert.equal(me(state).status, 'out');
  assert.equal(me(state).guessCount, 6);
  assert.equal(me(state).score, 0);
  assert.equal(state.status, 'playing');
  assert.equal(state.answer, null);
  assert.deepEqual(state.history, []);
  denied(await host.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  const unchanged = ok(await host.get(path));
  assert.equal(unchanged.guesses.length, 6);
  assert.equal(unchanged.answer, null);
  assert.equal(me(unchanged).score, 0);
  const ended = ok(await guest.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  assert.equal(ended.status, 'round-over');
  assert.equal(ended.answer, 'APPLE');
  assert.equal(ended.history.length, 1);
  assert.equal(ended.history[0].solvers.length, 1);
  assert.equal(ok(await host.get(path)).answer, 'APPLE');
});

test('concurrent tabs and replays award exactly one point per solve', async t => {
  const { server, host, guest, path } = await pair(t);
  ok(await host.post(`${path}/start`));
  const otherTab = server.client(host.cookie);
  const results = await Promise.all([host, otherTab].map(client =>
    client.post(`${path}/guess`, { word: 'APPLE', round: 1 })));
  assert.equal(results.filter(result => result.status >= 200 && result.status < 300).length, 1);
  denied(results.find(result => result.status >= 400));
  denied(await host.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  const state = ok(await otherTab.get(path));
  assert.equal(me(state).score, 1);
  assert.equal(me(state).status, 'solved');
  assert.equal(me(state).guessCount, 1);
  assert.equal(state.guesses.length, 1);
  assert.equal(state.answer, null);
  const opponent = ok(await guest.get(path));
  assert.deepEqual(opponent.guesses, []);
  assert.equal(opponent.answer, null);
  assert.ok(!JSON.stringify(opponent).includes('APPLE'));
});

test('round progression rejects stale actions and finishes into a clean rematch lobby', async t => {
  const { host, guest, path } = await pair(t);
  const started = ok(await host.post(`${path}/start`));
  const memberIds = started.players.map(player => player.id).sort();
  for (let round = 1; round <= 3; round++) {
    ok(await host.post(`${path}/guess`, { word: 'APPLE', round }));
    const ended = ok(await guest.post(`${path}/guess`, { word: 'APPLE', round }));
    assert.equal(ended.status, round === 3 ? 'finished' : 'round-over');
    assert.equal(ended.round, round);
    assert.equal(ended.answer, 'APPLE');
    assert.equal(ended.history.length, round);
    assert.deepEqual(ended.history.map(entry => entry.round), Array.from({ length: round }, (_, i) => i + 1));
    assert.ok(ended.players.every(player => player.score === round));
    assert.equal(ended.history.at(-1).solvers.length, 2);
    assert.equal(ended.guesses.length, 1);
    denied(await guest.post(`${path}/next`, { round }), [403]);
    if (round < 3) {
      const next = ok(await host.post(`${path}/next`, { round }));
      assert.equal(next.status, 'playing');
      assert.equal(next.round, round + 1);
      assert.equal(next.answer, null);
      assert.deepEqual(next.guesses, []);
      assert.ok(next.players.every(player => player.guessCount === 0 && player.status === 'playing'));
      denied(await host.post(`${path}/guess`, { word: 'APPLE', round }), [409]);
      denied(await host.post(`${path}/next`, { round }), [409]);
      const unchanged = ok(await host.get(path));
      assert.equal(me(unchanged).score, round);
      assert.deepEqual(unchanged.guesses, []);
    }
  }
  denied(await host.post(`${path}/next`, { round: 3 }));
  denied(await guest.post(`${path}/rematch`), [403]);
  const lobby = ok(await host.post(`${path}/rematch`));
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.round, 0);
  assert.equal(lobby.answer, null);
  assert.equal(lobby.deadline, null);
  assert.deepEqual(lobby.history, []);
  assert.deepEqual(lobby.guesses, []);
  assert.deepEqual(lobby.players.map(player => player.id).sort(), memberIds);
  assert.ok(lobby.players.every(player => player.score === 0 && player.guessCount === 0));
  assert.equal(ok(await host.post(`${path}/start`)).round, 1);
});

test('deadline expiry precedes guesses and never exposes the next round answer', async t => {
  let now = 1_800_000_000_000;
  const { host, guest, path } = await pair(t, { now: () => now, roundMs: 1000 });
  const started = ok(await host.post(`${path}/start`));
  assert.equal(started.serverTime, now);
  assert.equal(started.deadline, now + 1000);
  ok(await host.post(`${path}/guess`, { word: 'CRANE', round: 1 }));
  now = started.deadline;
  denied(await guest.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  const expired = ok(await guest.get(path));
  assert.equal(expired.status, 'round-over');
  assert.equal(expired.answer, 'APPLE');
  assert.equal(me(expired).score, 0);
  assert.equal(me(expired).guessCount, 0);
  assert.equal(expired.history.length, 1);
  assert.deepEqual(expired.history[0].solvers, []);
  const next = ok(await host.post(`${path}/next`, { round: 1 }));
  assert.equal(next.round, 2);
  assert.equal(next.answer, null);
  assert.equal(next.deadline, now + 1000);
  assert.equal(next.history.length, 1);
  denied(await guest.post(`${path}/guess`, { word: 'APPLE', round: 1 }), [409]);
  assert.equal(me(ok(await guest.get(path))).guessCount, 0);
  now = next.deadline;
  const expiredByRead = ok(await guest.get(path));
  assert.equal(expiredByRead.status, 'round-over');
  assert.equal(expiredByRead.history.length, 2);
  assert.ok(expiredByRead.players.every(player => player.score === 0));
});

test('SQLite restart restores room membership, scores and private boards with the same cookies', async t => {
  const { server, host, guest, path } = await pair(t, { persistent: true });
  ok(await host.post(`${path}/start`));
  const solved = ok(await host.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  const guessed = ok(await guest.post(`${path}/guess`, { word: 'CRANE', round: 1 }));
  const hostCookie = host.cookie;
  const guestCookie = guest.cookie;
  await server.restart();
  const restoredHost = server.client(hostCookie);
  const restoredGuest = server.client(guestCookie);
  const hostState = ok(await restoredHost.get(path));
  const guestState = ok(await restoredGuest.get(path));
  assert.equal(hostState.selfId, solved.selfId);
  assert.equal(hostState.hostId, solved.hostId);
  assert.equal(hostState.deadline, solved.deadline);
  assert.equal(hostState.status, 'playing');
  assert.equal(hostState.answer, null);
  assert.equal(me(hostState).score, 1);
  assert.deepEqual(hostState.guesses, solved.guesses);
  assert.equal(guestState.selfId, guessed.selfId);
  assert.deepEqual(guestState.guesses, guessed.guesses);
  assert.ok(!JSON.stringify(guestState).includes('APPLE'));
  denied(await restoredHost.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  const ended = ok(await restoredGuest.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  assert.equal(ended.status, 'round-over');
  assert.ok(ended.players.every(player => player.score === 1));
  await server.restart();
  const restoredEnd = ok(await restoredHost.get(path));
  assert.equal(restoredEnd.answer, 'APPLE');
  assert.deepEqual(restoredEnd.history, ended.history);
  assert.equal(ok(await restoredHost.post(`${path}/next`, { round: 1 })).round, 2);
});

test('cross-origin mutations and static private-file access are denied', async t => {
  const { server, host, path } = await pair(t);
  assert.deepEqual(ok(await host.get('/health')), { ok: true });
  const foreign = { Origin: 'https://attacker.example' };
  const blockedCreate = await server.client().post('/api/rooms', { name: 'Intruder', totalRounds: 3 }, foreign);
  denied(blockedCreate, [403]);
  assert.equal(blockedCreate.headers.get('access-control-allow-origin'), null);
  for (const [action, body] of [
    ['join', { name: 'Intruder' }], ['start', {}], ['guess', { word: 'APPLE', round: 1 }],
    ['next', { round: 1 }], ['rematch', {}],
  ]) denied(await host.post(`${path}/${action}`, body, foreign), [403]);
  assert.equal(ok(await host.get(path)).status, 'lobby');
  for (const privatePath of [
    '/server.mjs', '/package.json', '/data/answers.txt', '/data/allowed.txt',
    '/data/wordbloom.sqlite', '/game.sqlite', '/test/game.test.mjs',
    '/%2e%2e/server.mjs', '/public/../server.mjs',
  ]) denied(await host.get(privatePath), [404]);
  const created = await server.client().post('/api/rooms', { name: 'Cookie check', totalRounds: 3 });
  ok(created);
  const cookie = created.headers.getSetCookie().find(value => value.startsWith('wb_session='));
  assert.ok(cookie);
  assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(cookie, /;\s*SameSite=Strict(?:;|$)/i);
});

test('lobbies enforce unique names and an eight-player maximum', async t => {
  const server = await game(t);
  const host = server.client();
  const lobby = await create(host);
  const path = roomPath(lobby.code);
  denied(await server.client().post(`${path}/join`, { name: 'Host' }));
  denied(await server.client().post(`${path}/join`, { name: 'host' }));
  denied(await server.client().post(`${path}/join`, { name: '   ' }));
  for (let i = 1; i <= 7; i++) {
    const state = ok(await server.client().post(`${path}/join`, { name: `Player ${i}` }));
    assert.equal(state.players.length, i + 1);
  }
  denied(await server.client().post(`${path}/join`, { name: 'Ninth' }));
  const full = ok(await host.get(path));
  assert.equal(full.maxPlayers, 8);
  assert.equal(full.players.length, 8);
  assert.equal(new Set(full.players.map(player => player.name)).size, 8);
});

test('SSE sends an immediate personalized state and closes without leaving a stream', async t => {
  const { server, host, guest, path } = await pair(t);
  ok(await host.post(`${path}/start`));
  ok(await host.post(`${path}/guess`, { word: 'CRANE', round: 1 }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${server.base}${path}/events`, {
    headers: { Cookie: guest.cookie },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let buffer = '';
    let state;
    while (!state) {
      const { done, value } = await reader.read();
      assert.equal(done, false, 'SSE ended before its initial state');
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (/^event:\s*state$/m.test(frame)) {
          state = JSON.parse(frame.split('\n').filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n'));
          break;
        }
      }
    }
    assert.equal(state.selfId, ok(await guest.get(path)).selfId);
    assert.equal(state.status, 'playing');
    assert.equal(state.answer, null);
    assert.deepEqual(state.guesses, []);
    assert.ok(!JSON.stringify(state).includes('CRANE'));
    assert.ok(!JSON.stringify(state).includes('APPLE'));
  } finally {
    await reader.cancel();
    reader.releaseLock();
    controller.abort();
  }
});

const lengthAnswers = ['PEAR', 'APPLE', 'GARDEN', 'FLOWERS'];
for (const [wordLength, answer, duplicate, marks] of [
  [4, 'PEAR', 'EEEE', ['absent', 'correct', 'absent', 'absent']],
  [6, 'GARDEN', 'AAAAAA', ['absent', 'correct', 'absent', 'absent', 'absent', 'absent']],
  [7, 'FLOWERS', 'OOOOOOO', ['absent', 'absent', 'correct', 'absent', 'absent', 'absent', 'absent']],
]) {
  test(`${wordLength}-letter rooms enforce their chosen length through guesses and next rounds`, async t => {
    assert.deepEqual(scoreGuess(duplicate, answer), marks);
    const server = await game(t, {
      answers: lengthAnswers, allowedWords: new Set(lengthAnswers),
    });
    const host = server.client();
    const lobby = ok(await host.post('/api/rooms', { name: 'Host', totalRounds: 3, wordLength }));
    const path = roomPath(lobby.code);
    assert.equal(lobby.wordLength, wordLength);
    const started = ok(await host.post(`${path}/start`));
    assert.equal(started.wordLength, wordLength);
    for (const wrongLengthWord of lengthAnswers.filter(word => word.length !== wordLength)) {
      denied(await host.post(`${path}/guess`, {
        word: wrongLengthWord, round: 1, wordLength: wrongLengthWord.length,
      }));
      const unchanged = ok(await host.get(path));
      assert.equal(unchanged.wordLength, wordLength);
      assert.equal(me(unchanged).guessCount, 0);
      assert.equal(me(unchanged).score, 0);
      assert.deepEqual(unchanged.guesses, []);
    }
    const tamperedGuess = await host.post(`${path}/guess`, { word: answer, round: 1, wordLength: 5 });
    if (tamperedGuess.status >= 400) {
      denied(tamperedGuess);
      const unchanged = ok(await host.get(path));
      assert.equal(unchanged.wordLength, wordLength);
      assert.equal(me(unchanged).guessCount, 0);
      assert.equal(me(unchanged).score, 0);
      ok(await host.post(`${path}/guess`, { word: answer, round: 1 }));
    } else ok(tamperedGuess);
    const solved = ok(await host.get(path));
    assert.equal(solved.wordLength, wordLength);
    assert.equal(solved.status, 'round-over');
    assert.equal(solved.answer, answer);
    assert.equal(me(solved).score, 1);
    assert.equal(me(solved).guessCount, 1);
    assert.deepEqual(solved.guesses[0].marks, Array(wordLength).fill('correct'));
    const tamperedNext = await host.post(`${path}/next`, { round: 1, wordLength: 5 });
    if (tamperedNext.status >= 400) {
      denied(tamperedNext);
      const unchanged = ok(await host.get(path));
      assert.equal(unchanged.wordLength, wordLength);
      assert.equal(unchanged.round, 1);
      ok(await host.post(`${path}/next`, { round: 1 }));
    } else ok(tamperedNext);
    const next = ok(await host.get(path));
    assert.equal(next.wordLength, wordLength);
    assert.equal(next.round, 2);
    assert.equal(next.status, 'playing');
    assert.equal(next.answer, null);
    assert.deepEqual(next.guesses, []);
    const secondSolve = ok(await host.post(`${path}/guess`, { word: answer, round: 2 }));
    assert.equal(secondSolve.answer, answer);
    assert.equal(secondSolve.wordLength, wordLength);
    assert.equal(me(secondSolve).score, 2);
  });
}

test('word length defaults to five and unsupported lengths cannot create rooms', async t => {
  const server = await game(t, {
    answers: lengthAnswers, allowedWords: new Set(lengthAnswers),
  });
  const host = server.client();
  const lobby = await create(host);
  assert.equal(lobby.wordLength, 5);
  const path = roomPath(lobby.code);
  assert.equal(ok(await host.post(`${path}/start`)).wordLength, 5);
  const solved = ok(await host.post(`${path}/guess`, { word: 'APPLE', round: 1 }));
  assert.equal(solved.answer, 'APPLE');
  assert.equal(me(solved).score, 1);
  for (const wordLength of [0, 3, 8, 4.5, 'wide']) {
    denied(await server.client().post('/api/rooms', { name: 'Host', totalRounds: 3, wordLength }));
  }
});
