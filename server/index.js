#!/usr/bin/env node
// Local download server for the Video URL Finder extension.
// Runs in WSL, downloads HLS (m3u8) streams via ffmpeg into the Windows Downloads folder
// and reports progress back to the DevTools panel over a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';

const PORT = Number(process.env.PORT) || 9787;
const HOST = process.env.HOST || '127.0.0.1';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 3;
// Optional comma separated list of extension IDs allowed to use the server (default: any extension).
const ALLOWED_EXTENSION_IDS = (process.env.EXTENSION_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// How many finished (done/error/canceled) downloads are kept in the list.
const MAX_FINISHED = 50;
const MAX_BODY_SIZE = 1024 * 1024;
// Request headers the extension may forward to ffmpeg (needed by streams protected by referer/cookies).
const FORWARDED_HEADERS = ['referer', 'origin', 'cookie', 'authorization', 'accept-language'];
const ACTIVE_STATUSES = new Set(['queued', 'downloading']);
// Windows reserved device names.
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
// Playlist names that say nothing about the video.
const GENERIC_NAME_RE = /^(index|master|playlist|manifest|video|stream|chunklist.*|media.*)$/i;

const downloadDir = resolveDownloadDir();

if (!downloadDir || !fs.existsSync(downloadDir)) {
	console.error(`Download directory not found${downloadDir ? `: ${downloadDir}` : ''}. Set it via DOWNLOAD_DIR env variable.`);
	process.exit(1);
}

/** @type {Map<string, object>} id -> job */
const jobs = new Map();
const queue = [];
let nextId = 1;

function resolveDownloadDir() {
	if (process.env.DOWNLOAD_DIR) {
		return path.resolve(process.env.DOWNLOAD_DIR);
	}

	// Ask Windows for the current user profile (C:\Users\<user>) and convert it to a WSL path.
	try {
		const profile = execFileSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], {
			cwd: '/mnt/c',
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 10000,
		}).trim();

		if (profile && !profile.includes('%')) {
			const wslProfile = execFileSync('wslpath', ['-u', profile], { encoding: 'utf8' }).trim();

			return path.join(wslProfile, 'Downloads');
		}
	} catch (e) {
		// Not in WSL or interop disabled.
	}

	return null;
}

function publicJob(job) {
	return {
		id: job.id,
		url: job.url,
		title: job.title,
		fileName: path.basename(job.filePath),
		filePath: job.filePath,
		// ffmpeg may need a few seconds to stop (e.g. while blocked on a network read).
		status: job.status === 'downloading' && job.cancelRequested ? 'canceling' : job.status,
		progress: job.progress,
		durationSec: job.durationSec,
		downloadedSec: job.downloadedSec,
		sizeBytes: job.sizeBytes,
		speed: job.speed,
		error: job.error,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
	};
}

function sanitizeFileName(name) {
	return String(name)
		.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 150)
		// Windows doesn't allow trailing dots and spaces.
		.replace(/[. ]+$/, '');
}

function baseNameFor(title, url) {
	let name = sanitizeFileName(title || '');

	if (!name) {
		const parsed = new URL(url);
		let segment = path.posix.basename(parsed.pathname);

		try {
			segment = decodeURIComponent(segment);
		} catch (e) {
			// Keep the raw segment.
		}

		name = sanitizeFileName(segment.replace(/\.m3u8$/i, ''));

		if (!name || GENERIC_NAME_RE.test(name)) {
			const now = new Date();
			const pad = n => String(n).padStart(2, '0');
			const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

			name = `${parsed.hostname} ${stamp}`;
		}
	}

	return RESERVED_NAME_RE.test(name) ? `_${name}` : name;
}

function uniqueFilePath(baseName) {
	const reserved = new Set(Array.from(jobs.values()).filter(j => ACTIVE_STATUSES.has(j.status)).map(j => j.filePath));

	for (let i = 1; ; i++) {
		const fileName = i === 1 ? `${baseName}.mp4` : `${baseName} (${i}).mp4`;
		const filePath = path.join(downloadDir, fileName);

		if (!reserved.has(filePath) && !fs.existsSync(filePath) && !fs.existsSync(`${filePath}.part`)) {
			return filePath;
		}
	}
}

function normalizeHeaders(input) {
	const headers = {};

	if (!input || typeof input !== 'object') {
		return headers;
	}

	for (const [name, value] of Object.entries(input)) {
		const lower = name.toLowerCase();

		if ((FORWARDED_HEADERS.includes(lower) || lower === 'user-agent') && typeof value === 'string') {
			// CR/LF would allow injecting extra headers into ffmpeg's -headers option.
			const clean = value.replace(/[\r\n]+/g, ' ').trim();

			if (clean) {
				headers[lower] = clean;
			}
		}
	}

	return headers;
}

function createJob({ url, title, headers }) {
	const job = {
		id: String(nextId++),
		url,
		title: typeof title === 'string' ? title.trim().slice(0, 300) : '',
		headers: normalizeHeaders(headers),
		filePath: null,
		status: 'queued',
		progress: null,
		durationSec: null,
		downloadedSec: 0,
		sizeBytes: 0,
		speed: null,
		error: null,
		createdAt: Date.now(),
		startedAt: null,
		finishedAt: null,
		// Internal state, not sent to the client.
		proc: null,
		cancelRequested: false,
	};

	job.filePath = uniqueFilePath(baseNameFor(job.title, url));
	jobs.set(job.id, job);
	queue.push(job);
	pruneFinished();
	processQueue();

	return job;
}

function pruneFinished() {
	const finished = Array.from(jobs.values()).filter(j => !ACTIVE_STATUSES.has(j.status));

	for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
		jobs.delete(job.id);
	}
}

function processQueue() {
	const running = Array.from(jobs.values()).filter(j => j.status === 'downloading').length;

	for (let i = running; i < MAX_CONCURRENT && queue.length > 0; i++) {
		startJob(queue.shift());
	}
}

function parseDuration(text) {
	const match = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);

	return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function ffmpegArgs(job) {
	const partPath = `${job.filePath}.part`;
	const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1'];
	const { 'user-agent': userAgent, ...otherHeaders } = job.headers;
	const headerLines = Object.entries(otherHeaders).map(([name, value]) => `${name}: ${value}\r\n`).join('');

	if (userAgent) {
		args.push('-user_agent', userAgent);
	}

	if (headerLines) {
		args.push('-headers', headerLines);
	}

	args.push(
		'-i', job.url,
		// Default stream selection picks the best video and audio; subtitles and data (e.g. timed ID3)
		// can't be copied into mp4, so skip them.
		'-sn', '-dn',
		'-c', 'copy',
		'-f', 'mp4',
		partPath,
	);

	return { args, partPath };
}

function finishJob(job, status, error = null) {
	job.status = status;
	job.error = error;
	job.finishedAt = Date.now();
	job.proc = null;
	console.log(`[${job.id}] ${status}${error ? `: ${error}` : ''} – ${job.filePath}`);
	processQueue();
}

function removeFile(filePath) {
	fs.promises.unlink(filePath).catch(() => {});
}

function startJob(job) {
	const { args, partPath } = ffmpegArgs(job);
	const stderrTail = [];

	job.status = 'downloading';
	job.startedAt = Date.now();
	console.log(`[${job.id}] downloading ${job.url} -> ${job.filePath}`);

	const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

	job.proc = proc;

	// -progress writes key=value blocks to stdout.
	readline.createInterface({ input: proc.stdout }).on('line', line => {
		const eq = line.indexOf('=');

		if (eq < 0) {
			return;
		}

		const key = line.slice(0, eq);
		const value = line.slice(eq + 1).trim();

		if (key === 'out_time_us' && /^\d+$/.test(value)) {
			job.downloadedSec = Number(value) / 1e6;

			if (job.durationSec) {
				job.progress = Math.min(1, job.downloadedSec / job.durationSec);
			}
		} else if (key === 'total_size' && /^\d+$/.test(value)) {
			job.sizeBytes = Number(value);
		} else if (key === 'speed') {
			job.speed = value === 'N/A' ? null : value;
		}
	});

	readline.createInterface({ input: proc.stderr }).on('line', line => {
		if (job.durationSec === null) {
			job.durationSec = parseDuration(line);
		}

		// Strip the "[hls @ 0x…]" prefix; per-segment "Opening ... for reading" lines are noise for error reporting.
		const clean = line.replace(/^\[[^\]]* @ 0x[0-9a-f]+\]\s*/i, '').trim();

		if (clean && !/Opening '.*' for reading/.test(clean)) {
			stderrTail.push(clean);

			if (stderrTail.length > 20) {
				stderrTail.shift();
			}
		}
	});

	proc.on('error', err => {
		removeFile(partPath);
		finishJob(job, 'error', err.code === 'ENOENT' ? `ffmpeg not found (${FFMPEG})` : err.message);
	});

	proc.on('close', async (code, signal) => {
		// 'error' event already handled the failure (e.g. ffmpeg missing).
		if (job.status !== 'downloading') {
			return;
		}

		if (job.cancelRequested) {
			removeFile(partPath);
			finishJob(job, 'canceled');
			return;
		}

		if (code !== 0) {
			removeFile(partPath);
			finishJob(job, 'error', stderrTail.slice(-3).join('\n') || `ffmpeg exited with ${signal || code}`);
			return;
		}

		try {
			await fs.promises.rename(partPath, job.filePath);
			job.sizeBytes = (await fs.promises.stat(job.filePath)).size;
			job.progress = 1;
			finishJob(job, 'done');
		} catch (e) {
			finishJob(job, 'error', e.message);
		}
	});
}

function cancelJob(job) {
	if (job.status === 'queued') {
		queue.splice(queue.indexOf(job), 1);
		finishJob(job, 'canceled');
		return;
	}

	if (job.status === 'downloading' && job.proc) {
		const proc = job.proc;

		job.cancelRequested = true;
		proc.kill('SIGTERM');
		// ffmpeg may hang on a stalled network read.
		setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill('SIGKILL'), 5000).unref();
	}
}

// --- HTTP ---

function isAllowedOrigin(origin) {
	if (ALLOWED_EXTENSION_IDS.length > 0) {
		return ALLOWED_EXTENSION_IDS.some(id => origin === `chrome-extension://${id}`);
	}

	return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function sendJson(res, status, data, origin) {
	const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

	if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers.Vary = 'Origin';
	}

	res.writeHead(status, headers);
	res.end(JSON.stringify(data));
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];

		req.on('data', chunk => {
			size += chunk.length;

			if (size > MAX_BODY_SIZE) {
				reject(new Error('Request body too large'));
				req.destroy();
				return;
			}

			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
			} catch (e) {
				reject(new Error('Invalid JSON'));
			}
		});
		req.on('error', reject);
	});
}

function isValidVideoUrl(url) {
	try {
		const parsed = new URL(url);

		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch (e) {
		return false;
	}
}

async function handleRequest(req, res) {
	const origin = req.headers.origin;
	const host = (req.headers.host || '').replace(/:\d+$/, '');

	// Only IP/localhost hosts – protects against DNS rebinding from web pages.
	if (!/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i.test(host)) {
		sendJson(res, 403, { error: 'Invalid host' });
		return;
	}

	// Web pages must not be able to start downloads; only the extension may call the API.
	if (origin && !isAllowedOrigin(origin)) {
		sendJson(res, 403, { error: 'Origin not allowed' });
		return;
	}

	if (req.method === 'OPTIONS') {
		res.writeHead(204, {
			'Access-Control-Allow-Origin': origin || '*',
			'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Allow-Private-Network': 'true',
			'Access-Control-Max-Age': '600',
			Vary: 'Origin',
		});
		res.end();
		return;
	}

	const { pathname } = new URL(req.url, 'http://localhost');
	const idMatch = /^\/downloads\/([^/]+)$/.exec(pathname);

	if (req.method === 'GET' && pathname === '/health') {
		sendJson(res, 200, { ok: true, downloadDir }, origin);
		return;
	}

	if (req.method === 'GET' && pathname === '/downloads') {
		const downloads = Array.from(jobs.values()).reverse().map(publicJob);

		sendJson(res, 200, { downloads }, origin);
		return;
	}

	if (req.method === 'POST' && pathname === '/downloads') {
		if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
			sendJson(res, 415, { error: 'Content-Type must be application/json' }, origin);
			return;
		}

		let body;

		try {
			body = await readJsonBody(req);
		} catch (e) {
			sendJson(res, 400, { error: e.message }, origin);
			return;
		}

		if (!isValidVideoUrl(body.url)) {
			sendJson(res, 400, { error: 'Invalid URL' }, origin);
			return;
		}

		const job = createJob(body);

		sendJson(res, 201, { download: publicJob(job) }, origin);
		return;
	}

	if (req.method === 'DELETE' && idMatch) {
		const job = jobs.get(idMatch[1]);

		if (!job) {
			sendJson(res, 404, { error: 'Download not found' }, origin);
			return;
		}

		// Active download -> cancel, finished one -> remove from the list.
		if (ACTIVE_STATUSES.has(job.status)) {
			cancelJob(job);
		} else {
			jobs.delete(job.id);
		}

		sendJson(res, 200, { download: publicJob(job) }, origin);
		return;
	}

	sendJson(res, 404, { error: 'Not found' }, origin);
}

const server = http.createServer((req, res) => {
	handleRequest(req, res).catch(e => {
		console.error(e);

		if (!res.headersSent) {
			sendJson(res, 500, { error: 'Internal server error' });
		}
	});
});

server.listen(PORT, HOST, () => {
	console.log(`Video download server listening on http://${HOST}:${PORT}`);
	console.log(`Downloading to ${downloadDir}`);
});

function shutdown() {
	console.log('Shutting down, canceling running downloads…');
	server.close();

	const running = Array.from(jobs.values()).filter(j => j.status === 'downloading' && j.proc);

	queue.length = 0;

	if (running.length === 0) {
		process.exit(0);
	}

	let remaining = running.length;

	for (const job of running) {
		job.proc.once('close', () => {
			if (--remaining === 0) {
				// Give the .part cleanup a moment.
				setTimeout(() => process.exit(0), 200);
			}
		});
		cancelJob(job);
	}

	setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
