import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WEEK = 7 * 24 * 60 * 60 * 1000;
const YEAR = 365 * 24 * 60 * 60 * 1000;
const PRESENCE_GRACE = 8000;
const profileId = (sessionId) => createHash('sha256').update(`wordbloom-profile:${sessionId}`).digest('hex').slice(0, 32);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/activity.css', ['activity.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/sunflower-loader.js', ['sunflower-loader.js', 'text/javascript; charset=utf-8']],
  ['/sunflower-scene.js', ['sunflower-scene.js', 'text/javascript; charset=utf-8']],
  ['/sunflower-loader.css', ['sunflower-loader.css', 'text/css; charset=utf-8']],
  ['/vendor/three-0.181.0/three.module.min.js', ['vendor/three-0.181.0/three.module.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three-0.181.0/three.core.min.js', ['vendor/three-0.181.0/three.core.min.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three-0.181.0/LICENSE.txt', ['vendor/three-0.181.0/LICENSE.txt', 'text/plain; charset=utf-8']],
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
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data TEXT NOT NULL, finished INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS game_members (
      game_id TEXT NOT NULL REFERENCES games(id), session_id TEXT NOT NULL, PRIMARY KEY(game_id, session_id));
    CREATE INDEX IF NOT EXISTS game_members_session ON game_members(session_id, game_id);
    CREATE TABLE IF NOT EXISTS room_members (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE, session_id TEXT NOT NULL,
      PRIMARY KEY(room_code, session_id));
    CREATE INDEX IF NOT EXISTS room_members_session ON room_members(session_id, room_code);`);
  const writeRoom = db.prepare('INSERT INTO rooms VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data=excluded.data, updated=excluded.updated');
  const removeRoom = db.prepare('DELETE FROM rooms WHERE code=?');
  const writeRoomMember = db.prepare('INSERT OR IGNORE INTO room_members VALUES (?, ?)');
  const writeGame = db.prepare('INSERT OR IGNORE INTO games VALUES (?, ?, ?)');
  const writeGameMember = db.prepare('INSERT OR IGNORE INTO game_members VALUES (?, ?)');
  const findGames = db.prepare('SELECT games.data FROM games JOIN game_members ON games.id=game_members.game_id WHERE session_id=? ORDER BY finished DESC, games.id');
  const findGame = db.prepare('SELECT games.data FROM games JOIN game_members ON games.id=game_members.game_id WHERE games.id=? AND session_id=?');
  const findRooms = db.prepare('SELECT room_code FROM room_members WHERE session_id=?');
  const findSession = db.prepare('SELECT id, expires FROM sessions WHERE hash=?');
  const writeSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const renewSession = db.prepare('UPDATE sessions SET expires=? WHERE hash=?');
  const deleteSessions = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  // ponytail: one Node process owns room writes; use shared transactional storage before scaling to multiple instances.
  const rooms = new Map(db.prepare('SELECT code, data FROM rooms').all().map((row) => [row.code, JSON.parse(row.data)]));
  const streams = new Map();
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

  function session(req, res, create = false, optional = false) {
    let token = req.headers.cookie?.match(/(?:^|;\s*)wb_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    let id;
    if (token) {
      const hash = createHash('sha256').update(token).digest('hex');
      const row = findSession.get(hash);
      if (row && row.expires > now()) {
        id = row.id;
        if (row.expires < now() + YEAR - 86_400_000) renewSession.run(now() + YEAR, hash);
      }
    }
    if (!id) {
      if (optional && !create) return null;
      requireThat(create, 403, 'Join this room first.');
      token = randomBytes(32).toString('base64url');
      id = randomUUID();
      writeSession.run(createHash('sha256').update(token).digest('hex'), id, now() + YEAR);
    }
    const secure = process.env.COOKIE_SECURE === '1' || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `wb_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`);
    return id;
  }

  function member(room, sessionId) {
    const player = room.players.find((p) => p.sessionId === sessionId);
    requireThat(player, 403, 'You are not in this room. Ask your friend for an invite.');
    return player;
  }

  function connected(room, player) {
    return [...(streams.get(room.code) || [])].some((client) => client.sessionId === player.sessionId);
  }

  function online(room, player) {
    return connected(room, player) || (player.awayAt === null && now() - player.lastSeenAt < PRESENCE_GRACE);
  }

  function publicPlayers(room) {
    return room.players.map((p) => ({
      id: p.id, profileId: profileId(p.sessionId), name: p.name, score: p.score,
      status: p.status, guessCount: p.guesses.length, online: online(room, p),
    }));
  }

  function publicRound(entry, sessionId) {
    return {
      round: entry.round, answer: entry.answer, finishedAt: entry.finishedAt,
      solvers: entry.solvers,
      players: entry.players.map(({ id, name, status, guessCount }) => ({ id, name, status, guessCount })),
      guesses: entry.players.find((p) => p.id === profileId(sessionId))?.guesses || [],
    };
  }

  function view(room, sessionId) {
    const me = member(room, sessionId);
    return {
      code: room.code, gameId: room.gameId, status: room.status, round: room.round,
      totalRounds: room.totalRounds, wordLength: room.wordLength,
      deadline: room.deadline, serverTime: now(), hostId: room.hostId, selfId: me.id,
      selfProfileId: profileId(sessionId), maxPlayers: 8,
      remainingMs: room.status === 'paused' ? room.remainingMs : null, pausedAt: room.pausedAt,
      players: publicPlayers(room), guesses: me.guesses,
      answer: room.status === 'round-over' || room.status === 'finished' ? room.answer : null,
      history: room.history.map((entry) => publicRound(entry, sessionId)),
    };
  }

  function summary(game) {
    const players = game.players.map(({ id, name, score }) => ({ id, name, score }));
    const best = Math.max(0, ...players.map((p) => p.score));
    return {
      id: game.id, roomCode: game.roomCode, wordLength: game.wordLength, totalRounds: game.totalRounds,
      finishedAt: game.finishedAt, players,
      winners: best > 0 ? players.filter((p) => p.score === best).map((p) => p.id) : [],
    };
  }

  function archive(room) {
    if (room.status !== 'finished') return;
    const game = {
      id: room.gameId, roomCode: room.code, wordLength: room.wordLength, totalRounds: room.totalRounds,
      finishedAt: room.finishedAt, rounds: room.history,
      players: room.players.map((p) => ({ id: profileId(p.sessionId), sessionId: p.sessionId, name: p.name, score: p.score })),
    };
    writeGame.run(game.id, JSON.stringify(game), game.finishedAt);
    for (const p of room.players) writeGameMember.run(game.id, p.sessionId);
  }

  function persist(room, updated) {
    room.updated = updated;
    if (room.status === 'playing') room.remainingMs = Math.max(0, room.deadline - now());
    writeRoom.run(room.code, JSON.stringify(room), room.updated);
    for (const p of room.players) writeRoomMember.run(room.code, p.sessionId);
    archive(room);
  }

  function save(room) {
    db.exec('BEGIN IMMEDIATE');
    try { persist(room, now()); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function broadcast(room) {
    for (const client of streams.get(room.code) || []) {
      if (client.res.writableLength > 131072) { client.res.end(); continue; }
      client.res.write(`event: state\ndata: ${JSON.stringify(view(room, client.sessionId))}\n\n`);
    }
  }
  const publish = (room) => { save(room); broadcast(room); };

  function recordRound(room, finishedAt) {
    return {
      round: room.round, answer: room.answer, finishedAt,
      solvers: room.players.filter((p) => p.status === 'solved').map((p) => p.name),
      players: room.players.map((p) => ({
        id: profileId(p.sessionId), name: p.name, status: p.status, guessCount: p.guesses.length,
        guesses: p.guesses,
      })),
    };
  }

  function settle(room) {
    if (room.status !== 'playing') return false;
    const unfinished = room.players.some((p) => p.status === 'playing');
    if (unfinished && now() < room.deadline) return false;
    const finishedAt = unfinished ? room.deadline : now();
    for (const p of room.players) if (p.status === 'playing') p.status = 'out';
    room.status = room.round === room.totalRounds ? 'finished' : 'round-over';
    room.deadline = null; room.remainingMs = null; room.pausedAt = null;
    room.history.push(recordRound(room, finishedAt));
    if (room.status === 'finished') room.finishedAt = finishedAt;
    return true;
  }

  function pause(room, at) {
    room.remainingMs = Math.max(0, room.deadline - at);
    room.status = 'paused'; room.pausedAt = at; room.deadline = null;
  }

  function maintain(room) {
    let changed = false;
    if (room.status === 'playing') {
      // Everyone finishing is terminal even if their departure beacon arrives first.
      if (room.players.every((p) => p.status !== 'playing')) changed = settle(room);
      else {
        const departures = room.players.map((p) => {
          if (connected(room, p)) return null;
          const absentSince = p.awayAt ?? p.lastSeenAt;
          if (now() - absentSince < PRESENCE_GRACE) return null;
          return p.awayAt ?? p.lastSeenAt + PRESENCE_GRACE;
        });
        const pausedAt = departures.every((at) => at !== null) ? Math.max(...departures) : null;
        if (pausedAt !== null && pausedAt < room.deadline) { pause(room, pausedAt); changed = true; }
        else changed = settle(room);
      }
    }
    const host = room.players.find((p) => p.id === room.hostId);
    if (!online(room, host) && now() - (host.awayAt ?? host.lastSeenAt) >= PRESENCE_GRACE) {
      const replacement = room.players.find((p) => online(room, p));
      if (replacement) { room.hostId = replacement.id; changed = true; }
    }
    return changed;
  }

  function touch(room, player) {
    player.lastSeenAt = now(); player.awayAt = null;
    if (maintain(room)) publish(room);
    else save(room);
  }

  function beginRound(room) {
    const candidates = answerPools.get(room.wordLength);
    const unused = candidates.filter((word) => !room.usedAnswers.includes(word));
    const pool = unused.length ? unused : candidates;
    room.answer = pool[randomInt(pool.length)];
    room.usedAnswers.push(room.answer);
    room.round++;
    room.status = 'playing';
    room.deadline = now() + roundMs; room.remainingMs = roundMs; room.pausedAt = null;
    for (const player of room.players) { player.guesses = []; player.status = 'playing'; player.lastGuessAt = null; }
  }

  function newPlayer(name, sessionId) {
    return { id: randomUUID(), sessionId, name, score: 0, guesses: [], status: 'waiting',
      lastGuessAt: null, lastSeenAt: now(), awayAt: null };
  }

  function library(sessionId) {
    if (!sessionId) return { me: null, rooms: [], games: [], leaderboard: [] };
    const ownRooms = findRooms.all(sessionId).map(({ room_code }) => rooms.get(room_code))
      .filter((room) => room && now() - room.updated < YEAR).sort((a, b) => b.updated - a.updated || a.code.localeCompare(b.code));
    const games = findGames.all(sessionId).map((row) => JSON.parse(row.data));
    const stats = new Map();
    const include = (id, name) => {
      if (!stats.has(id)) stats.set(id, { id, name, points: 0, games: 0, wins: 0, rounds: 0, solved: 0, accuracy: 0, rank: 0 });
      return stats.get(id);
    };
    for (const room of ownRooms) for (const p of room.players) include(profileId(p.sessionId), p.name);
    for (const game of games) {
      const winners = summary(game).winners;
      for (const p of game.players) {
        const stat = include(p.id, p.name);
        stat.points += p.score; stat.games++;
        if (winners.includes(p.id)) stat.wins++;
        for (const round of game.rounds) {
          const outcome = round.players.find((player) => player.id === p.id);
          if (outcome) { stat.rounds++; if (outcome.status === 'solved') stat.solved++; }
        }
      }
    }
    const leaderboard = [...stats.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    for (let i = 0; i < leaderboard.length; i++) {
      const p = leaderboard[i];
      p.accuracy = p.rounds ? Math.round(p.solved / p.rounds * 100) : 0;
      p.rank = i && leaderboard[i - 1].points === p.points ? leaderboard[i - 1].rank : i + 1;
    }
    return {
      me: stats.get(profileId(sessionId)) || null,
      rooms: ownRooms.map((room) => ({
        code: room.code, gameId: room.gameId, status: room.status, round: room.round,
        totalRounds: room.totalRounds, wordLength: room.wordLength, updatedAt: room.updated,
        remainingMs: room.status === 'paused' ? room.remainingMs : null, hostId: room.hostId, players: publicPlayers(room),
      })),
      games: games.map(summary), leaderboard,
    };
  }

  // Upgrade room JSON and identity expiry in the same transaction as archive/membership backfills.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('PRAGMA user_version').get().user_version < 1) {
      db.prepare('UPDATE sessions SET expires=expires+?').run(YEAR - WEEK);
    }
    for (const room of rooms.values()) {
      const legacy = !room.schemaVersion;
      room.gameId ||= randomUUID();
      room.wordLength ||= 5;
      room.pausedAt ??= null; room.remainingMs ??= null;
      room.finishedAt ??= room.status === 'finished' ? room.updated : null;
      for (const p of room.players) { p.lastSeenAt ??= room.updated; p.awayAt ??= null; }
      room.history = room.history.map((entry) => {
        if (entry.players) return entry;
        const recorded = ['round-over', 'finished'].includes(room.status) && entry.round === room.round;
        return {
          ...entry, finishedAt: null,
          players: room.players.map((p) => ({
            id: profileId(p.sessionId), name: p.name, status: entry.solvers.includes(p.name) ? 'solved' : 'out',
            guessCount: recorded ? p.guesses.length : null, guesses: recorded ? p.guesses : [],
          })),
        };
      });
      if (room.status === 'playing') {
        if (!legacy && room.remainingMs !== null) room.deadline = now() + room.remainingMs;
        if (!settle(room)) pause(room, now());
      }
      room.schemaVersion = 1;
      persist(room, room.updated);
    }
    db.prepare('DELETE FROM rooms WHERE updated <= ?').run(now() - YEAR);
    deleteSessions.run(now());
    db.exec('PRAGMA user_version=1; COMMIT');
    for (const [code, room] of rooms) if (now() - room.updated >= YEAR) rooms.delete(code);
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }

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
        if (path.startsWith('/vendor/three-0.181.0/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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

      if (path === '/api/library' && req.method === 'GET') {
        return json(res, 200, library(session(req, res, false, true)));
      }
      const gameRoute = path.match(/^\/api\/games\/([a-f0-9-]{36})$/);
      if (gameRoute && req.method === 'GET') {
        const sid = session(req, res, false, true);
        const row = sid && findGame.get(gameRoute[1], sid);
        requireThat(row, 404, 'Not found.');
        const game = JSON.parse(row.data);
        return json(res, 200, { ...summary(game), rounds: game.rounds.map((entry) => publicRound(entry, sid)) });
      }
      const playerRoute = path.match(/^\/api\/players\/([a-f0-9]{32})$/);
      if (playerRoute && req.method === 'GET') {
        const sid = session(req, res, false, true);
        const player = library(sid).leaderboard.find((p) => p.id === playerRoute[1]);
        requireThat(player, 404, 'Not found.');
        const games = findGames.all(sid).map((row) => JSON.parse(row.data))
          .filter((game) => game.players.some((p) => p.id === player.id));
        return json(res, 200, {
          player, games: games.map(summary),
          rounds: games.flatMap((game) => game.rounds.flatMap((entry) => {
            const outcome = entry.players.find((p) => p.id === player.id);
            return outcome ? [{
              gameId: game.id, roomCode: game.roomCode, round: entry.round, wordLength: game.wordLength,
              finishedAt: entry.finishedAt, answer: entry.answer, status: outcome.status,
              guessCount: outcome.guessCount, guesses: player.id === profileId(sid) ? outcome.guesses : [],
            }] : [];
          })),
        });
      }

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
        const room = { code, gameId: randomUUID(), schemaVersion: 1, status: 'lobby', round: 0,
          totalRounds, wordLength, deadline: null, remainingMs: null, pausedAt: null, finishedAt: null,
          answer: null, usedAnswers: [], history: [], hostId: player.id, players: [player], updated: now() };
        save(room);
        rooms.set(code, room);
        return json(res, 201, view(room, sid));
      }

      const route = path.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|start|guess|next|rematch|events|away|resume))?$/);
      requireThat(route, 404, 'Not found.');
      const [, code, action] = route;
      let room = rooms.get(code);
      requireThat(room && now() - room.updated < YEAR, 404, 'This room does not exist or has expired.');
      if (maintain(room)) publish(room);

      if (action === 'join' && req.method === 'POST') {
        rateLimit(`join:${ip}`, 40, 60_000);
        const data = await readJson(req);
        const name = playerName(data.name);
        // Body reads are asynchronous; re-read the room before validating a mutation.
        room = rooms.get(code);
        if (maintain(room)) publish(room);
        const sid = session(req, res, true);
        const existing = room.players.find((p) => p.sessionId === sid);
        if (existing) { touch(room, existing); return json(res, 200, view(room, sid)); }
        requireThat(room.status === 'lobby', 409, 'This game has started. Join your friends for the next game.');
        requireThat(room.players.length < 8, 409, 'This room is full (8 players).');
        requireThat(!room.players.some((p) => p.name.toLowerCase() === name.toLowerCase()), 409, 'That name is already in this room. Try another.');
        room.players.push(newPlayer(name, sid));
        publish(room);
        return json(res, 200, view(room, sid));
      }

      const sid = session(req, res);
      let me = member(room, sid);
      if (!action && req.method === 'GET') {
        touch(room, me);
        return json(res, 200, view(room, sid));
      }
      if (action === 'events' && req.method === 'GET') {
        let connections = streams.get(code);
        if (!connections) { connections = new Set(); streams.set(code, connections); }
        requireThat([...connections].filter((client) => client.sessionId === sid).length < 3, 429, 'This room is open in too many tabs.');
        touch(room, me);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const client = { res, sessionId: sid };
        connections.add(client);
        res.on('close', () => {
          connections.delete(client);
          if (!connections.size) streams.delete(code);
          if (!closing) {
            if (!connected(room, me)) {
              me.lastSeenAt = now();
              if (me.awayAt !== null) me.awayAt = now();
            }
            maintain(room);
            publish(room);
          }
        });
        broadcast(room);
        return;
      }

      requireThat(req.method === 'POST' && ['start', 'guess', 'next', 'rematch', 'away', 'resume'].includes(action), 405, 'Method not allowed.');
      const data = await readJson(req);
      room = rooms.get(code);
      me = member(room, sid);
      if (maintain(room)) publish(room);
      if (action !== 'away') touch(room, me);
      if (['start', 'next', 'rematch'].includes(action)) requireThat(me.id === room.hostId, 403, 'Only the host can do that.');

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
      } else if (action === 'away') {
        me.awayAt = now();
        maintain(room);
      } else if (action === 'resume') {
        requireThat(['paused', 'playing'].includes(room.status), 409, 'There is no paused round to resume.');
        if (room.status === 'paused') {
          room.status = 'playing'; room.deadline = now() + room.remainingMs; room.pausedAt = null;
        }
      } else if (action === 'rematch') {
        requireThat(room.status === 'finished', 409, 'Finish this game before a rematch.');
        // The finished game was archived transactionally when its last round settled.
        room.gameId = randomUUID();
        room.status = 'lobby'; room.round = 0; room.answer = null; room.deadline = null;
        room.remainingMs = null; room.pausedAt = null; room.finishedAt = null;
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
    for (const room of rooms.values()) if (maintain(room)) publish(room);
  }, 1000).unref();
  const heartbeat = setInterval(() => {
    for (const connections of streams.values()) for (const client of connections) client.res.write(': heartbeat\n\n');
    for (const [key, window] of rateWindows) if (now() >= window.until) rateWindows.delete(key);
    for (const [code, room] of rooms) {
      if (now() - room.updated >= YEAR && !streams.has(code)) { rooms.delete(code); removeRoom.run(code); }
      else if (streams.has(code)) save(room);
    }
    deleteSessions.run(now());
  }, 20_000).unref();

  async function close() {
    closing = true;
    clearInterval(tick); clearInterval(heartbeat);
    for (const room of rooms.values()) {
      const changed = maintain(room);
      if (room.status === 'playing') { pause(room, now()); save(room); }
      else if (changed) save(room);
    }
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
