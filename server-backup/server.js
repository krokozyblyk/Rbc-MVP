'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const PORT = Number(process.env.PORT) || 3000;

// Прямой (единственный живой) фид Радио РБК: HLS, AAC-LC 112 kbps, сегменты *.aac
const STREAMS = {
  112: 'https://hls-01-rbc.hostingradio.ru/rbc-fed0/112/playlist.m3u8'
};
const DEFAULT_BITRATE = 112;

const KILL_GRACE_MS = 5000;      // не убиваем ffmpeg сразу, слушатель может переподключиться
const NO_DATA_TIMEOUT_MS = 15000; // ffmpeg не принёс байтов — отвечаем 503
const MAX_BUFFER_BYTES = 4 * 1024 * 1024; // слушатель отстаёт больше 4 МБ — кикаем

const ffmpegAvailable = { value: null };

const stations = new Map(); // bitrate -> { proc, listeners:Set<res>, killTimer, bitrate }

const app = express();
app.disable('x-powered-by');

// CORS — фронт на Vercel ходит напрямую на этот прокси
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (req, res) => res.sendStatus(204));

function sendStreamHeaders(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
}

function failListener(res, status, message) {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).type('text/plain; charset=utf-8').send(message);
}

function unsubscribe(station, res) {
  station.listeners.delete(res);
  if (station.listeners.size > 0) return;
  clearTimeout(station.killTimer);
  station.killTimer = setTimeout(() => {
    if (station.listeners.size > 0) return;
    if (stations.get(station.bitrate) !== station) return;
    stations.delete(station.bitrate);
    try { station.proc.kill('SIGKILL'); } catch (_) { /* уже мёртв */ }
  }, KILL_GRACE_MS);
}

function ensureStation(bitrate) {
  const existing = stations.get(bitrate);
  if (existing && existing.proc.exitCode === null && !existing.proc.killed) {
    return existing;
  }

  const proc = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', STREAMS[bitrate],
    '-vn', '-sn', '-dn',
    '-threads', '1',
    '-f', 'mp3',
    '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const station = { proc, listeners: new Set(), killTimer: null, bitrate };
  stations.set(bitrate, station);
  clearTimeout(station.killTimer);

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000);
  });
  proc.stdout.on('error', () => { /* EPIPE после kill — ожидаемо */ });
  proc.stderr.on('error', () => { /* игнорируем */ });

  proc.stdout.on('data', (chunk) => {
    for (const res of Array.from(station.listeners)) {
      if (res.destroyed || res.writableEnded) {
        station.listeners.delete(res);
        continue;
      }
      if (res.writableLength > MAX_BUFFER_BYTES) {
        station.listeners.delete(res);
        res.destroy();
        continue;
      }
      sendStreamHeaders(res);
      res.write(chunk);
    }
  });

  proc.on('error', (err) => {
    ffmpegAvailable.value = false;
    for (const res of Array.from(station.listeners)) {
      station.listeners.delete(res);
      failListener(res, 503, 'ffmpeg is not available on the server: ' + err.message);
    }
    stations.delete(bitrate);
  });

  proc.on('close', (code) => {
    if (stations.get(bitrate) === station) stations.delete(bitrate);
    const reason = stderr.trim() || ('ffmpeg exited with code ' + code);
    for (const res of Array.from(station.listeners)) {
      station.listeners.delete(res);
      if (!res.headersSent) {
        failListener(res, 503, 'Upstream stream unavailable: ' + reason);
      } else {
        try { res.end(); } catch (_) { /* клиент уже ушёл */ }
      }
    }
  });

  return station;
}

app.get('/stream', (req, res) => {
  const requested = req.query.bitrate === undefined
    ? DEFAULT_BITRATE
    : Number(req.query.bitrate);

  if (!Object.prototype.hasOwnProperty.call(STREAMS, requested)) {
    return res
      .status(400)
      .set({ 'Access-Control-Allow-Origin': '*' })
      .type('text/plain; charset=utf-8')
      .send('Unsupported bitrate. MVP serves bitrate=112 only.');
  }

  const station = ensureStation(requested);
  clearTimeout(station.killTimer);
  station.listeners.add(res);

  const guard = setTimeout(() => {
    if (res.headersSent) return;
    failListener(res, 503, 'No audio data received from upstream');
  }, NO_DATA_TIMEOUT_MS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(guard);
    unsubscribe(station, res);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
});

let ffmpegCheckDone = false;
const ffmpegVersion = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
ffmpegVersion.on('error', () => { ffmpegAvailable.value = false; ffmpegCheckDone = true; });
ffmpegVersion.on('close', (code) => { ffmpegAvailable.value = code === 0; ffmpegCheckDone = true; });

app.get('/health', (req, res) => {
  let listeners = 0;
  for (const station of stations.values()) listeners += station.listeners.size;
  res.json({
    ok: true,
    ffmpeg: ffmpegCheckDone ? ffmpegAvailable.value : null,
    upstream: STREAMS[DEFAULT_BITRATE],
    activeStations: stations.size,
    activeListeners: listeners
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('RBC radio proxy listening on :' + PORT);
});
