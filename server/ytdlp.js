// Download of any video supported by yt-dlp (YouTube, Vimeo, …).
// Video info is fetched first (yt-dlp -J) so the job knows its title and file name right away,
// the download itself then reuses the info (--load-info-json) without extracting the page again.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const YTDLP = process.env.YTDLP || 'yt-dlp';
// Format sorting: best quality up to Full HD (falls back to 720p etc.), prefer mp4.
const FORMAT_SORT = process.env.YTDLP_FORMAT_SORT || 'res:1080,ext';
// Optional cookies.txt (Netscape format) – for age restricted / members only videos.
const COOKIES = process.env.YTDLP_COOKIES || '';
// JS runtime for solving YouTube challenges (https://github.com/yt-dlp/yt-dlp/wiki/EJS) – by default the Node.js
// running this server; needs the yt-dlp-ejs solver package. Set to an empty string to use yt-dlp's default (deno).
const JS_RUNTIME = process.env.YTDLP_JS_RUNTIME ?? `node:${process.execPath}`;
const KILL_TIMEOUT = 5000;
const PROGRESS_PREFIX = 'VFDL ';
const POSTPROCESS_PREFIX = 'VFPP ';
const FILE_PREFIX = 'VFFILE ';

function commonArgs() {
	return [
		'--ignore-config',
		'--no-playlist',
		'-S', FORMAT_SORT,
		...(JS_RUNTIME ? ['--js-runtimes', JS_RUNTIME] : []),
		...(COOKIES ? ['--cookies', COOKIES] : []),
	];
}

function errorFromStderr(lines, fallback) {
	const errors = lines.filter(line => line.startsWith('ERROR:'));

	return (errors.length > 0 ? errors : lines).slice(-2).join('\n').replace(/^ERROR:\s*/gm, '') || fallback;
}

function spawnError(err) {
	return new Error(err.code === 'ENOENT' ? `yt-dlp not found (${YTDLP})` : err.message);
}

/** Fetches video info (yt-dlp -J). Returns the parsed info JSON. */
export function fetchVideoInfo(url, signal) {
	return new Promise((resolve, reject) => {
		const proc = spawn(YTDLP, [...commonArgs(), '--flat-playlist', '-J', '--', url], { stdio: ['ignore', 'pipe', 'pipe'], signal });
		const stdout = [];
		const stderr = [];

		proc.stdout.on('data', chunk => stdout.push(chunk));
		readline.createInterface({ input: proc.stderr }).on('line', line => stderr.push(line.trim()));
		proc.on('error', err => reject(err.name === 'AbortError' ? new Error('Fetching video info timed out') : spawnError(err)));
		proc.on('close', code => {
			if (code !== 0) {
				reject(new Error(errorFromStderr(stderr, `yt-dlp exited with ${code}`)));
				return;
			}

			let info;

			try {
				info = JSON.parse(Buffer.concat(stdout).toString('utf8'));
			} catch (e) {
				reject(new Error('yt-dlp returned invalid info JSON'));
				return;
			}

			if (info._type === 'playlist' || info._type === 'multi_video') {
				reject(new Error('Playlists are not supported, use a link to a single video'));
				return;
			}

			resolve(info);
		});
	});
}

function formatDate(date) {
	const pad = n => String(n).padStart(2, '0');

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYY-MM-DD Title" like %(upload_date>%Y-%m-%d)s %(title)s, falls back to today when the date is unknown. */
export function videoFileBaseName(info) {
	const ymd = [info.upload_date, info.release_date].find(d => /^\d{8}$/.test(d || ''));
	const timestamp = info.timestamp ?? info.release_timestamp;
	let date;

	if (ymd) {
		date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
	} else {
		date = formatDate(Number.isFinite(timestamp) ? new Date(timestamp * 1000) : new Date());
	}

	return `${date} ${info.title || info.id || 'video'}`;
}

/** Planned streams (video + audio are downloaded separately and merged). */
function plannedStreams(info) {
	const formats = Array.isArray(info.requested_formats) && info.requested_formats.length > 0 ? info.requested_formats : [info];

	return formats.map(f => ({ id: String(f.format_id), size: f.filesize || f.filesize_approx || null }));
}

function killTree(proc, signalName) {
	try {
		// Negative PID = the whole process group (yt-dlp + its ffmpeg).
		process.kill(-proc.pid, signalName);
	} catch (e) {
		proc.kill(signalName);
	}
}

/**
 * Downloads the video into partPath, updates job progress.
 * yt-dlp works in a temporary folder next to the target file (merging needs separate video/audio files),
 * the result is then moved to partPath.
 */
export async function downloadYtdlp(job, partPath, signal) {
	const tmpDir = `${partPath}.tmp`;
	const infoPath = path.join(tmpDir, 'info.json');
	const streams = plannedStreams(job.ytdlpInfo);
	const totalBytes = streams.every(s => s.size) ? streams.reduce((sum, s) => sum + s.size, 0) : null;

	await fs.promises.mkdir(tmpDir, { recursive: true });

	try {
		await fs.promises.writeFile(infoPath, JSON.stringify(job.ytdlpInfo));
		// Not needed anymore, can be a few MB.
		job.ytdlpInfo = null;
		job.totalBytes = totalBytes;

		const outputFile = await runDownload(job, infoPath, tmpDir, streams, signal);

		await fs.promises.rename(outputFile, partPath);
	} finally {
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

function runDownload(job, infoPath, tmpDir, streams, signal) {
	const args = [
		...commonArgs(),
		'--load-info-json', infoPath,
		// The folder name contains the video title – escape "%" so it isn't parsed as an output template field.
		'-o', path.join(tmpDir.replace(/%/g, '%%'), 'video.%(ext)s'),
		'--no-mtime',
		'--newline',
		'--progress',
		'--progress-template', `download:${PROGRESS_PREFIX}%(info.format_id)s %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s %(progress.speed)s`,
		'--progress-template', `postprocess:${POSTPROCESS_PREFIX}%(progress.postprocessor)s %(progress.status)s`,
		'--print', `after_move:${FILE_PREFIX}%(filepath)s`,
	];

	return new Promise((resolve, reject) => {
		const stderrTail = [];
		const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
		const startedAt = Date.now();
		let outputFile = null;
		let streamIndex = -1;
		let currentId = null;
		let finishedBytes = 0;
		let currentBytes = 0;

		const onAbort = () => {
			killTree(proc, 'SIGTERM');
			setTimeout(() => proc.exitCode === null && proc.signalCode === null && killTree(proc, 'SIGKILL'), KILL_TIMEOUT).unref();
		};

		signal.addEventListener('abort', onAbort, { once: true });

		const onProgress = text => {
			const [formatId, downloaded, total] = text.split(' ');
			const downloadedBytes = Number(downloaded) || 0;
			const streamTotal = Number(total) || 0;

			if (formatId !== currentId) {
				finishedBytes += currentBytes;
				currentId = formatId;
				streamIndex = Math.max(streamIndex + 1, streams.findIndex(s => s.id === formatId));
			}

			currentBytes = downloadedBytes;
			job.sizeBytes = finishedBytes + downloadedBytes;
			job.note = streams.length > 1 ? `stream ${Math.min(streamIndex, streams.length - 1) + 1}/${streams.length}` : null;

			if (job.totalBytes) {
				job.progress = Math.min(1, job.sizeBytes / job.totalBytes);
			} else if (streamTotal) {
				job.progress = Math.min(1, (Math.min(streamIndex, streams.length - 1) + Math.min(1, downloadedBytes / streamTotal)) / streams.length);
			}

			const seconds = (Date.now() - startedAt) / 1000;

			job.speed = seconds > 0.5 ? `${(job.sizeBytes / seconds / 1024 / 1024).toFixed(1)} MB/s` : null;
		};

		const onLine = line => {
			if (line.startsWith(PROGRESS_PREFIX)) {
				onProgress(line.slice(PROGRESS_PREFIX.length));
			} else if (line.startsWith(POSTPROCESS_PREFIX)) {
				const [name, status] = line.slice(POSTPROCESS_PREFIX.length).split(' ');

				if (status === 'started' && name !== 'MoveFiles') {
					job.progress = 1;
					job.speed = null;
					job.note = name === 'Merger' ? 'merging video and audio…' : `post-processing (${name})…`;
				}
			} else if (line.startsWith(FILE_PREFIX)) {
				outputFile = line.slice(FILE_PREFIX.length).trim();
			} else if (line.trim()) {
				stderrTail.push(line.trim());

				if (stderrTail.length > 20) {
					stderrTail.shift();
				}
			}
		};

		readline.createInterface({ input: proc.stdout }).on('line', onLine);
		readline.createInterface({ input: proc.stderr }).on('line', onLine);

		let settled = false;

		proc.on('error', err => {
			settled = true;
			signal.removeEventListener('abort', onAbort);
			reject(spawnError(err));
		});

		proc.on('close', (code, exitSignal) => {
			if (settled) {
				return;
			}

			signal.removeEventListener('abort', onAbort);
			job.note = null;

			if (code === 0 && !signal.aborted && outputFile) {
				resolve(outputFile);
			} else {
				reject(new Error(errorFromStderr(stderrTail, code === 0 ? 'yt-dlp did not report the output file' : `yt-dlp exited with ${exitSignal || code}`)));
			}
		});
	});
}
