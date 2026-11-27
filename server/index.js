#!/usr/bin/env node
// Local download server for the Video URL Finder extension.
// Runs in WSL, downloads any video via yt-dlp, HLS (m3u8) streams via ffmpeg and files from public
// Google Drive folders into the Windows Downloads folder and reports progress back to the extension over a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { downloadHls } from './hls.js';
import { parseDriveFolderUrl, findDriveFiles, downloadDriveFile } from './drive.js';
import { fetchVideoInfo, videoFileBaseName, downloadYtdlp } from './ytdlp.js';

const PORT = Number(process.env.PORT) || 9787;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 3;
// Optional comma separated list of extension IDs allowed to use the server (default: any extension).
const ALLOWED_EXTENSION_IDS = (process.env.EXTENSION_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// How many finished (done/error/canceled) downloads are kept in the list.
const MAX_FINISHED = 50;
const MAX_BODY_SIZE = 1024 * 1024;
// Max. number of files started by one Google Drive request.
const MAX_DRIVE_FILES = 100;
// Request headers the extension may forward to ffmpeg (needed by streams protected by referer/cookies).
const FORWARDED_HEADERS = ['referer', 'origin', 'cookie', 'authorization', 'accept-language'];
const ACTIVE_STATUSES = new Set(['queued', 'downloading']);
// Windows reserved device names.
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
// Playlist names that say nothing about the video.
const GENERIC_NAME_RE = /^(index|master|playlist|manifest|video|stream|chunklist.*|media.*)$/i;
const RUNNERS = {
	hls: downloadHls,
	drive: downloadDriveFile,
	ytdlp: downloadYtdlp,
};

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
		kind: job.kind,
		url: job.url,
		title: job.title,
		fileName: path.basename(job.filePath),
		filePath: job.filePath,
		// Stopping may take a few seconds (e.g. ffmpeg blocked on a network read).
		status: job.status === 'downloading' && job.cancelRequested ? 'canceling' : job.status,
		progress: job.progress,
		durationSec: job.durationSec,
		downloadedSec: job.downloadedSec,
		sizeBytes: job.sizeBytes,
		totalBytes: job.totalBytes,
		speed: job.speed,
		note: job.note,
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

function localTimestamp() {
	const now = new Date();
	const pad = n => String(n).padStart(2, '0');

	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function videoBaseName(title, url) {
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
			name = `${parsed.hostname} ${localTimestamp()}`;
		}
	}

	return name;
}

function uniqueFilePath(baseName, ext) {
	const reserved = new Set(Array.from(jobs.values()).filter(j => ACTIVE_STATUSES.has(j.status)).map(j => j.filePath));
	const base = RESERVED_NAME_RE.test(baseName) ? `_${baseName}` : baseName || 'download';

	for (let i = 1; ; i++) {
		const fileName = i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`;
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

function createJob(props) {
	const job = {
		id: String(nextId++),
		kind: 'hls',
		url: '',
		title: '',
		headers: {},
		filePath: null,
		status: 'queued',
		progress: null,
		durationSec: null,
		downloadedSec: 0,
		sizeBytes: 0,
		totalBytes: null,
		speed: null,
		note: null,
		error: null,
		createdAt: Date.now(),
		startedAt: null,
		finishedAt: null,
		...props,
		// Internal state, not sent to the client.
		abortController: null,
		cancelRequested: false,
		finished: null,
	};

	job.finished = new Promise(resolve => (job.resolveFinished = resolve));
	jobs.set(job.id, job);
	queue.push(job);
	pruneFinished();
	processQueue();

	return job;
}

function createHlsJob({ url, title, headers }) {
	const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 300) : '';

	return createJob({
		kind: 'hls',
		url,
		title: cleanTitle,
		headers: normalizeHeaders(headers),
		filePath: uniqueFilePath(videoBaseName(cleanTitle, url), '.mp4'),
	});
}

function createDriveJob(file) {
	const ext = path.extname(file.name);
	const baseName = sanitizeFileName(file.name.slice(0, file.name.length - ext.length));

	return createJob({
		kind: 'drive',
		url: `https://drive.google.com/file/d/${file.id}/view`,
		title: `${file.folderPath}${file.name}`,
		driveId: file.id,
		filePath: uniqueFilePath(baseName, sanitizeFileName(ext)),
	});
}

function createYtdlpJob(url, info) {
	const ext = typeof info.ext === 'string' && /^\w{1,10}$/.test(info.ext) ? `.${info.ext}` : '.mp4';

	return createJob({
		kind: 'ytdlp',
		url: typeof info.webpage_url === 'string' && isValidVideoUrl(info.webpage_url) ? info.webpage_url : url,
		title: String(info.title || '').slice(0, 300),
		ytdlpInfo: info,
		filePath: uniqueFilePath(sanitizeFileName(videoFileBaseName(info)), ext),
	});
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

function finishJob(job, status, error = null) {
	job.status = status;
	job.error = error;
	job.finishedAt = Date.now();
	job.abortController = null;
	// yt-dlp video info (can be a few MB) isn't needed anymore, e.g. when canceled while queued.
	job.ytdlpInfo = null;
	console.log(`[${job.id}] ${status}${error ? `: ${error}` : ''} – ${job.filePath}`);
	job.resolveFinished();
	processQueue();
}

async function startJob(job) {
	const partPath = `${job.filePath}.part`;

	job.status = 'downloading';
	job.startedAt = Date.now();
	job.abortController = new AbortController();
	console.log(`[${job.id}] downloading ${job.url} -> ${job.filePath}`);

	try {
		await RUNNERS[job.kind](job, partPath, job.abortController.signal);

		if (job.cancelRequested) {
			throw new Error('Canceled');
		}

		await fs.promises.rename(partPath, job.filePath);
		job.sizeBytes = (await fs.promises.stat(job.filePath)).size;
		job.progress = 1;
		finishJob(job, 'done');
	} catch (e) {
		await fs.promises.unlink(partPath).catch(() => {});

		if (job.cancelRequested) {
			finishJob(job, 'canceled');
		} else {
			finishJob(job, 'error', e.message);
		}
	}
}

function cancelJob(job) {
	if (job.status === 'queued') {
		queue.splice(queue.indexOf(job), 1);
		finishJob(job, 'canceled');
		return;
	}

	if (job.status === 'downloading' && !job.cancelRequested) {
		job.cancelRequested = true;
		job.abortController?.abort();
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

function normalizeExtensions(input) {
	const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);

	return Array.from(new Set(list
		.filter(ext => typeof ext === 'string')
		.map(ext => ext.trim().toLowerCase().replace(/^\*?\.?/, '.'))
		.filter(ext => /^\.[\w.-]{1,20}$/.test(ext))));
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
	let body = null;

	if (req.method === 'POST') {
		if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
			sendJson(res, 415, { error: 'Content-Type must be application/json' }, origin);
			return;
		}

		try {
			body = await readJsonBody(req);
		} catch (e) {
			sendJson(res, 400, { error: e.message }, origin);
			return;
		}
	}

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
		if (!isValidVideoUrl(body.url)) {
			sendJson(res, 400, { error: 'Invalid URL' }, origin);
			return;
		}

		const job = createHlsJob(body);

		sendJson(res, 201, { download: publicJob(job) }, origin);
		return;
	}

	// Download any video supported by yt-dlp.
	if (req.method === 'POST' && pathname === '/ytdlp') {
		if (!isValidVideoUrl(body.url)) {
			sendJson(res, 400, { error: 'Invalid URL' }, origin);
			return;
		}

		let info;

		try {
			info = await fetchVideoInfo(body.url, AbortSignal.timeout(120000));
		} catch (e) {
			console.warn(`yt-dlp ${body.url}: ${e.message}`);
			sendJson(res, 502, { error: e.message }, origin);
			return;
		}

		const job = createYtdlpJob(body.url, info);

		sendJson(res, 201, { download: publicJob(job) }, origin);
		return;
	}

	// Find files with given extensions in a public Google Drive folder (incl. subfolders) and download them.
	if (req.method === 'POST' && pathname === '/drive') {
		const folderId = parseDriveFolderUrl(body.url);
		const extensions = normalizeExtensions(body.extensions);

		if (!folderId) {
			sendJson(res, 400, { error: 'Not a Google Drive folder URL (https://drive.google.com/drive/folders/…)' }, origin);
			return;
		}

		if (extensions.length === 0) {
			sendJson(res, 400, { error: 'No file extensions given' }, origin);
			return;
		}

		let files;

		try {
			files = await findDriveFiles(folderId, extensions, AbortSignal.timeout(60000));
		} catch (e) {
			console.warn(`Drive folder ${folderId}: ${e.message}`);
			sendJson(res, 502, { error: e.message }, origin);
			return;
		}

		if (files.length === 0) {
			sendJson(res, 404, { error: `No ${extensions.join(', ')} files found in the folder` }, origin);
			return;
		}

		if (files.length > MAX_DRIVE_FILES) {
			sendJson(res, 413, { error: `Too many files (${files.length}), the limit is ${MAX_DRIVE_FILES}` }, origin);
			return;
		}

		const downloads = files.map(file => publicJob(createDriveJob(file)));

		sendJson(res, 201, { downloads }, origin);
		return;
	}

	// Clear the list – removes finished downloads, running ones stay.
	if (req.method === 'DELETE' && pathname === '/downloads') {
		for (const job of jobs.values()) {
			if (!ACTIVE_STATUSES.has(job.status)) {
				jobs.delete(job.id);
			}
		}

		sendJson(res, 200, { ok: true }, origin);
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
	console.log(`Download server listening on http://${HOST}:${PORT}`);
	console.log(`Downloading to ${downloadDir}`);
});

async function shutdown() {
	console.log('Shutting down, canceling running downloads…');
	server.close();
	setTimeout(() => process.exit(1), 8000).unref();

	const running = Array.from(jobs.values()).filter(j => j.status === 'downloading');

	queue.length = 0;
	running.forEach(cancelJob);
	// Wait for the .part files cleanup.
	await Promise.all(running.map(j => j.finished));
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
