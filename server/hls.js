// HLS (m3u8) and DASH (mpd) download via ffmpeg.
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
// ffmpeg may hang on a stalled network read and ignore SIGTERM for a while.
const KILL_TIMEOUT = 5000;
// Some CDNs (e.g. ceskatelevize.cz DASH) occasionally never answer a segment request and ffmpeg then waits forever –
// fail the download when no data arrives for this long.
const STALL_TIMEOUT = 90000;
const STALL_CHECK_INTERVAL = 5000;

function parseDuration(text) {
	const match = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);

	return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function ffmpegArgs(job, partPath) {
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
		// streamUrl – stream found by an extractor, url is then the page URL.
		'-i', job.streamUrl || job.url,
		// Default stream selection picks the best video and audio; subtitles and data (e.g. timed ID3)
		// can't be copied into mp4, so skip them.
		'-sn', '-dn',
		'-c', 'copy',
		'-f', 'mp4',
		partPath,
	);

	return args;
}

/**
 * Downloads an HLS or DASH stream into partPath (mp4), updates job progress.
 * Resolves on success, rejects on failure or abort.
 */
export function downloadHls(job, partPath, signal) {
	return new Promise((resolve, reject) => {
		const stderrTail = [];
		const proc = spawn(FFMPEG, ffmpegArgs(job, partPath), { stdio: ['ignore', 'pipe', 'pipe'] });
		let lastDataAt = Date.now();
		let stalled = false;

		const stop = () => {
			proc.kill('SIGTERM');
			setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill('SIGKILL'), KILL_TIMEOUT).unref();
		};
		const onAbort = () => stop();
		const stallTimer = setInterval(() => {
			if (!stalled && Date.now() - lastDataAt > STALL_TIMEOUT) {
				stalled = true;
				stop();
			}
		}, STALL_CHECK_INTERVAL);

		signal.addEventListener('abort', onAbort, { once: true });

		// -progress writes key=value blocks to stdout.
		readline.createInterface({ input: proc.stdout }).on('line', line => {
			const eq = line.indexOf('=');

			if (eq < 0) {
				return;
			}

			const key = line.slice(0, eq);
			const value = line.slice(eq + 1).trim();

			if (key === 'out_time_us' && /^\d+$/.test(value)) {
				if (Number(value) / 1e6 !== job.downloadedSec) {
					lastDataAt = Date.now();
				}

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

		let settled = false;

		proc.on('error', err => {
			settled = true;
			clearInterval(stallTimer);
			signal.removeEventListener('abort', onAbort);
			reject(new Error(err.code === 'ENOENT' ? `ffmpeg not found (${FFMPEG})` : err.message));
		});

		proc.on('close', (code, exitSignal) => {
			if (settled) {
				return;
			}

			clearInterval(stallTimer);
			signal.removeEventListener('abort', onAbort);

			if (stalled) {
				reject(new Error(`Stream stalled – no data for ${STALL_TIMEOUT / 1000} s, try again`));
			} else if (code === 0 && !signal.aborted) {
				resolve();
			} else {
				reject(new Error(stderrTail.slice(-3).join('\n') || `ffmpeg exited with ${exitSignal || code}`));
			}
		});
	});
}
