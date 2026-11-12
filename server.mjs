import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEEK = 7 * 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const wordsFrom = (file) => readFileSync(join(ROOT, 'data', file), 'utf8').trim().toUpperCase().split(/\s+/);

// Exact matches consume letters before misplaced matches, including duplicates.
export function scoreGuess(guess, answer) {
  const marks = Array(answer.length).fill('absent');
  const remaining = {};
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) marks[i] = 'correct';
    else remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < answer.length; i++) {
    if (marks[i] !== 'correct' && remaining[guess[i]] > 0) {
      marks[i] = 'present';
      remaining[guess[i]]--;
    }
  }
  return marks;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const requireThat = (condition, status, message) => { if (!condition) throw new HttpError(status, message); };

function readJson(req) {
  requireThat(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, 'Send application/json.');
  return new Promise((resolveBody, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2048) {
        if (!tooLarge) reject(new HttpError(413, 'That request is too large.'));
        tooLarge = true;
      } else body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const value = JSON.parse(body);
        requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, 'Send a JSON object.');
        resolveBody(value);
      } catch (error) { reject(error instanceof HttpError ? error : new HttpError(400, 'That request is not valid JSON.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Request interrupted.')));
  });
}

function playerName(value) {
  requireThat(typeof value === 'string', 400, 'What should we call you?');
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  requireThat(/^[\p{L}\p{N} ._'’-]{1,20}$/u.test(name), 400, 'Use 1–20 letters, numbers, spaces, or simple punctuation.');
  return name;
}

export function createGameServer({
  dbPath = process.env.DB_PATH || join(ROOT, '.data', 'wordbloom.sqlite'),
  answers = [...wordsFrom('answers.txt'), ...wordsFrom('extra-answers.txt')],
  allowedWords = new Set([...wordsFrom('guesses.txt'), ...wordsFrom('english.txt'), ...answers]),
  roundMs = 180_000,
  guessCooldownMs = 500,
  now = Date.now,
} = {}) {
  requireThat(answers.length > 0 && answers.every((word) => /^[A-Z]{4,7}$/.test(word)), 500, 'Invalid answer dictionary.');
  const answerPools = new Map([4, 5, 6, 7].map((length) => [length, answers.filter((word) => word.length === length)]));
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, id TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const writeRoom = db.prepare('INSERT INTO rooms VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data=excluded.data, updated=excluded.updated');
  const removeRoom = db.prepare('DELETE FROM rooms WHERE code=?');
  const findSession = db.prepare('SELECT id, expires FROM sessions WHERE hash=?');
  const writeSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const deleteSessions = db.prepare('DELETE FROM sessions WHERE expires < ?');
  db.prepare('DELETE FROM rooms WHERE updated < ?').run(now() - WEEK);
  deleteSessions.run(now());
  // ponytail: one Node process owns room writes; use shared transactional storage before scaling to multiple instances.
  const rooms = new Map(db.prepare('SELECT code, data FROM rooms').all().map((row) => [row.code, JSON.parse(row.data)]));
  const streams = new Map();
  const lastSeen = new Map();
  const rateWindows = new Map();
  let closing = false;

  function rateLimit(key, max, windowMs) {
    let window = rateWindows.get(key);
    if (!window || now() >= window.until) {
      window = { count: 0, until: now() + windowMs };
      rateWindows.set(key, window);
    }
    requireThat(++window.count <= max, 429, 'A little too fast. Please try again shortly.');
  }

  function session(req, res, create = false) {
    const token = req.headers.cookie?.match(/(?:^|;\s*)wb_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    if (token) {
      const row = findSession.get(createHash('sha256').update(token).digest('hex'));
      if (row && row.expires > now()) return row.id;
    }
    requireThat(create, 403, 'Join this room first.');
    const freshToken = randomBytes(32).toString('base64url');
    const id = randomUUID();
    writeSession.run(createHash('sha256').update(freshToken).digest('hex'), id, now() + WEEK);
    const secure = process.env.COOKIE_SECURE === '1' || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `wb_session=${freshToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`);
    return id;
  }

  function member(room, sessionId) {
    const player = room.players.find((p) => p.sessionId === sessionId);
    requireThat(player, 403, 'You are not in this room. Ask your friend for an invite.');
    return player;
  }

  function view(room, sessionId) {
    const me = member(room, sessionId);
    lastSeen.set(`${room.code}:${me.id}`, now());
    const connections = streams.get(room.code);
    return {
      code: room.code, status: room.status, round: room.round, totalRounds: room.totalRounds, wordLength: room.wordLength,
      deadline: room.deadline, serverTime: now(), hostId: room.hostId, selfId: me.id, maxPlayers: 8,
      players: room.players.map((p) => ({
        id: p.id, name: p.name, score: p.score, status: p.status, guessCount: p.guesses.length,
        online: now() - (lastSeen.get(`${room.code}:${p.id}`) ?? -Infinity) < 8000 || Boolean(connections && [...connections].some((client) => client.sessionId === p.sessionId)),
      })),
      guesses: me.guesses,
      answer: room.status === 'round-over' || room.status === 'finished' ? room.answer : null,
      history: room.history,
    };
  }

  function save(room) {
    room.updated = now();
    writeRoom.run(room.code, JSON.stringify(room), room.updated);
  }

  function broadcast(room) {
    for (const client of streams.get(room.code) || []) {
      if (client.res.writableLength > 131072) { client.res.end(); continue; }
      client.res.write(`event: state\ndata: ${JSON.stringify(view(room, client.sessionId))}\n\n`);
    }
  }
  const publish = (room) => { save(room); broadcast(room); };

  function settle(room) {
    if (room.status !== 'playing') return false;
    if (now() < room.deadline && room.players.some((p) => p.status === 'playing')) return false;
    for (const p of room.players) if (p.status === 'playing') p.status = 'out';
    room.status = room.round === room.totalRounds ? 'finished' : 'round-over';
    room.deadline = null;
    room.history.push({ round: room.round, answer: room.answer, solvers: room.players.filter((p) => p.status === 'solved').map((p) => p.name) });
    return true;
  }

  function beginRound(room) {
    const candidates = answerPools.get(room.wordLength);
    const unused = candidates.filter((word) => !room.usedAnswers.includes(word));
    const pool = unused.length ? unused : candidates;
    room.answer = pool[randomInt(pool.length)];
    room.usedAnswers.push(room.answer);
    room.round++;
    room.status = 'playing';
    room.deadline = now() + roundMs;
    for (const player of room.players) { player.guesses = []; player.status = 'playing'; player.lastGuessAt = null; }
  }

  function newPlayer(name, sessionId) {
    return { id: randomUUID(), sessionId, name, score: 0, guesses: [], status: 'waiting', lastGuessAt: null };
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://wordbloom.local').pathname;
      if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (!path.startsWith('/api/')) {
        requireThat(req.method === 'GET' || req.method === 'HEAD', 405, 'Method not allowed.');
        const asset = STATIC.get(path);
        requireThat(asset, 404, 'Not found.');
        let content;
        try { content = readFileSync(join(ROOT, 'public', asset[0])); }
        catch { throw new HttpError(404, 'Not found.'); }
        res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': content.length });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }

      const origin = req.headers.origin;
      if (origin) {
        let source;
        try { source = new URL(origin); } catch { throw new HttpError(403, 'Cross-origin requests are not allowed.'); }
        requireThat(['http:', 'https:'].includes(source.protocol) && source.host === req.headers.host, 403, 'Cross-origin requests are not allowed.');
      }
      requireThat(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'Cross-site requests are not allowed.');
      const ip = req.socket.remoteAddress || 'unknown';
      rateLimit(`requests:${ip}`, 240, 60_000);

      if (path === '/api/rooms' && req.method === 'POST') {
        rateLimit(`create:${ip}`, 20, 600_000);
        const data = await readJson(req);
        const name = playerName(data.name);
        const totalRounds = data.totalRounds ?? 5;
        requireThat([3, 5, 10].includes(totalRounds), 400, 'Choose 3, 5, or 10 rounds.');
        const wordLength = data.wordLength ?? 5;
        requireThat([4, 5, 6, 7].includes(wordLength), 400, 'Choose 4, 5, 6, or 7 letters.');
        requireThat(answerPools.get(wordLength).length > 0, 400, 'No words available for that length.');
        requireThat(rooms.size < 2000, 503, 'The garden is full. Please try again later.');
        const sid = session(req, res, true);
        rateLimit(`create-session:${sid}`, 10, 600_000);
        let code;
        do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
        const player = newPlayer(name, sid);
        const room = { code, status: 'lobby', round: 0, totalRounds, wordLength, deadline: null, answer: null, usedAnswers: [], history: [], hostId: player.id, players: [player], updated: now() };
        save(room);
        rooms.set(code, room);
        return json(res, 201, view(room, sid));
      }

      const route = path.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|start|guess|next|rematch|events))?$/);
      requireThat(route, 404, 'Not found.');
      const [, code, action] = route;
      let room = rooms.get(code);
      requireThat(room && now() - room.updated < WEEK, 404, 'This room does not exist or has expired.');
      if (settle(room)) publish(room);

      if (action === 'join' && req.method === 'POST') {
        rateLimit(`join:${ip}`, 40, 60_000);
        const data = await readJson(req);
        const name = playerName(data.name);
        // Body reads are asynchronous; re-read the room before validating a mutation.
        room = rooms.get(code);
        const sid = session(req, res, true);
        if (room.players.some((p) => p.sessionId === sid)) return json(res, 200, view(room, sid));
        requireThat(room.status === 'lobby', 409, 'This game has started. Join your friends for the next game.');
        requireThat(room.players.length < 8, 409, 'This room is full (8 players).');
        requireThat(!room.players.some((p) => p.name.toLowerCase() === name.toLowerCase()), 409, 'That name is already in this room. Try another.');
        room.players.push(newPlayer(name, sid));
        publish(room);
        return json(res, 200, view(room, sid));
      }

      const sid = session(req, res);
      let me = member(room, sid);
      if (!action && req.method === 'GET') return json(res, 200, view(room, sid));
      if (action === 'events' && req.method === 'GET') {
        let connections = streams.get(code);
        if (!connections) { connections = new Set(); streams.set(code, connections); }
        requireThat([...connections].filter((client) => client.sessionId === sid).length < 3, 429, 'This room is open in too many tabs.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const client = { res, sessionId: sid };
        connections.add(client);
        res.on('close', () => {
          connections.delete(client);
          if (!connections.size) streams.delete(code);
          if (!closing) broadcast(room);
        });
        broadcast(room);
        return;
      }

      requireThat(req.method === 'POST' && ['start', 'guess', 'next', 'rematch'].includes(action), 405, 'Method not allowed.');
      const data = await readJson(req);
      room = rooms.get(code);
      me = member(room, sid);
      if (settle(room)) publish(room);
      if (action !== 'guess') requireThat(me.id === room.hostId, 403, 'Only the host can do that.');

      if (action === 'start') {
        requireThat(room.status === 'lobby', 409, 'This game has already started.');
        beginRound(room);
      } else if (action === 'guess') {
        requireThat(data.round === room.round, 409, 'The round changed. Refresh your board.');
        requireThat(room.status === 'playing' && me.status === 'playing', 409, 'Your guesses for this round are complete.');
        requireThat(typeof data.word === 'string' && data.word.length === room.wordLength && /^[A-Za-z]+$/.test(data.word), 400, `Enter a ${room.wordLength}-letter word.`);
        const word = data.word.toUpperCase();
        requireThat(allowedWords.has(word), 422, 'Not in the word list. Try another word.');
        requireThat(!me.guesses.some((guess) => guess.word === word), 409, 'You have already tried that word.');
        requireThat(me.lastGuessAt === null || now() - me.lastGuessAt >= guessCooldownMs, 429, 'Give those letters a moment.');
        requireThat(me.guesses.length < 6, 409, 'All six guesses are used.');
        me.guesses.push({ word, marks: scoreGuess(word, room.answer) });
        me.lastGuessAt = now();
        if (word === room.answer) { me.status = 'solved'; me.score++; }
        else if (me.guesses.length === 6) me.status = 'out';
        settle(room);
      } else if (action === 'next') {
        requireThat(data.round === room.round, 409, 'The round has already changed.');
        requireThat(room.status === 'round-over', 409, 'Everyone must finish before the next round.');
        beginRound(room);
      } else if (action === 'rematch') {
        requireThat(room.status === 'finished', 409, 'Finish this game before a rematch.');
        room.status = 'lobby'; room.round = 0; room.answer = null; room.deadline = null;
        room.usedAnswers = []; room.history = [];
        for (const player of room.players) { player.score = 0; player.guesses = []; player.status = 'waiting'; player.lastGuessAt = null; }
      }
      publish(room);
      return json(res, 200, view(room, sid));
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Wordbloom request failed:', error);
      if (res.headersSent) return res.end();
      if (error.status === 429) res.setHeader('Retry-After', '1');
      json(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  const tick = setInterval(() => {
    for (const room of rooms.values()) if (settle(room)) publish(room);
  }, 1000).unref();
  const heartbeat = setInterval(() => {
    for (const connections of streams.values()) for (const client of connections) client.res.write(': heartbeat\n\n');
    for (const [key, window] of rateWindows) if (now() >= window.until) rateWindows.delete(key);
    for (const [key, seenAt] of lastSeen) if (now() - seenAt >= 8000) lastSeen.delete(key);
    for (const [code, room] of rooms) {
      if (now() - room.updated >= WEEK && !streams.has(code)) { rooms.delete(code); removeRoom.run(code); }
    }
    deleteSessions.run(now());
  }, 20_000).unref();

  async function close() {
    closing = true;
    clearInterval(tick); clearInterval(heartbeat);
    for (const connections of streams.values()) for (const client of connections) client.res.end();
    if (server.listening) {
      await new Promise((done) => { server.close(done); server.closeAllConnections(); });
    }
    db.close();
  }
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createGameServer();
  const port = Number(process.env.PORT || 4318);
  app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Wordbloom listening on http://127.0.0.1:${port}`));
  const shutdown = () => app.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
