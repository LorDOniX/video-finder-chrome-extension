// HLS (m3u8) download via ffmpeg.
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
// ffmpeg may hang on a stalled network read and ignore SIGTERM for a while.
const KILL_TIMEOUT = 5000;

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
		'-i', job.url,
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
 * Downloads an HLS stream into partPath (mp4), updates job progress.
 * Resolves on success, rejects on failure or abort.
 */
export function downloadHls(job, partPath, signal) {
	return new Promise((resolve, reject) => {
		const stderrTail = [];
		const proc = spawn(FFMPEG, ffmpegArgs(job, partPath), { stdio: ['ignore', 'pipe', 'pipe'] });

		const onAbort = () => {
			proc.kill('SIGTERM');
			setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill('SIGKILL'), KILL_TIMEOUT).unref();
		};

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
			signal.removeEventListener('abort', onAbort);
			reject(new Error(err.code === 'ENOENT' ? `ffmpeg not found (${FFMPEG})` : err.message));
		});

		proc.on('close', (code, exitSignal) => {
			if (settled) {
				return;
			}

			signal.removeEventListener('abort', onAbort);

			if (code === 0 && !signal.aborted) {
				resolve();
			} else {
				reject(new Error(stderrTail.slice(-3).join('\n') || `ffmpeg exited with ${exitSignal || code}`));
			}
		});
	});
}
