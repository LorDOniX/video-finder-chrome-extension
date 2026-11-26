// Public Google Drive folders: listing files and downloading them without an API key.
// The folder listing is read from the data embedded in the folder web page (window['_DRIVE_ivd']),
// which is undocumented – if Google changes the page, this is the place to fix.
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_DEPTH = 5;
const MAX_FOLDERS = 100;
const REQUEST_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
};

/** Returns the folder ID from a Drive folder URL, or null. */
export function parseDriveFolderUrl(url) {
	let parsed;

	try {
		parsed = new URL(url);
	} catch (e) {
		return null;
	}

	if (parsed.protocol !== 'https:' || parsed.hostname !== 'drive.google.com') {
		return null;
	}

	// https://drive.google.com/drive/folders/<id>, also /drive/u/0/folders/<id>
	const match = /\/folders\/([\w-]+)/.exec(parsed.pathname);

	if (match) {
		return match[1];
	}

	// https://drive.google.com/open?id=<id>
	const id = parsed.searchParams.get('id');

	return id && /^[\w-]+$/.test(id) ? id : null;
}

// Decodes a single-quoted JS string literal body ('\x5b\x22...').
function decodeJsString(s) {
	const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

	return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (m, esc) => {
		if (esc.length > 1) {
			return String.fromCharCode(parseInt(esc.slice(1), 16));
		}

		return simple[esc] ?? esc;
	});
}

async function listFolder(folderId, signal) {
	const res = await fetch(`https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`, { headers: REQUEST_HEADERS, signal });

	if (!res.ok) {
		throw new Error(`Google Drive returned HTTP ${res.status} for folder ${folderId}`);
	}

	const html = await res.text();
	const match = /window\['_DRIVE_ivd'\]\s*=\s*'((?:[^'\\]|\\[\s\S])*)'/.exec(html);

	if (!match) {
		throw new Error('Folder content not found – is the folder shared publicly ("Anyone with the link")?');
	}

	const data = JSON.parse(decodeJsString(match[1]));

	return (data?.[0] || [])
		.filter(item => Array.isArray(item) && typeof item[0] === 'string' && typeof item[2] === 'string')
		.map(item => ({ id: item[0], name: item[2], mimeType: item[3] }));
}

/**
 * Recursively finds files with one of the given extensions (e.g. ['.gpx', '.gp']).
 * Returns [{ id, name, folderPath }].
 */
export async function findDriveFiles(folderId, extensions, signal) {
	const wanted = extensions.map(ext => ext.toLowerCase());
	const found = [];
	const visited = new Set();
	const pending = [{ id: folderId, path: '', depth: 0 }];

	while (pending.length > 0) {
		const folder = pending.shift();

		if (visited.has(folder.id) || visited.size >= MAX_FOLDERS) {
			continue;
		}

		visited.add(folder.id);

		for (const item of await listFolder(folder.id, signal)) {
			if (item.mimeType === FOLDER_MIME) {
				if (folder.depth < MAX_DEPTH) {
					pending.push({ id: item.id, path: `${folder.path}${item.name}/`, depth: folder.depth + 1 });
				}
			} else if (wanted.some(ext => item.name.toLowerCase().endsWith(ext))) {
				found.push({ id: item.id, name: item.name, folderPath: folder.path });
			}
		}
	}

	return found;
}

// Larger files return a "can't scan for viruses" HTML page with a form that confirms the download.
function confirmUrlFromHtml(html) {
	const form = /<form[^>]+id="download-form"[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/.exec(html);

	if (!form) {
		return null;
	}

	const url = new URL(form[1].replace(/&amp;/g, '&'));

	for (const input of form[2].matchAll(/<input[^>]+type="hidden"[^>]*>/g)) {
		const name = /name="([^"]*)"/.exec(input[0])?.[1];
		const value = /value="([^"]*)"/.exec(input[0])?.[1] ?? '';

		if (name) {
			url.searchParams.set(name, value.replace(/&amp;/g, '&'));
		}
	}

	return url.href;
}

/** Downloads a Drive file into partPath, updates job progress. */
export async function downloadDriveFile(job, partPath, signal) {
	let res = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(job.driveId)}&export=download`, { headers: REQUEST_HEADERS, signal });

	if (res.ok && /text\/html/i.test(res.headers.get('content-type') || '')) {
		const confirmUrl = confirmUrlFromHtml(await res.text());

		if (!confirmUrl) {
			throw new Error('Google Drive returned a page instead of the file (no access or download limit exceeded)');
		}

		res = await fetch(confirmUrl, { headers: REQUEST_HEADERS, signal });
	}

	if (!res.ok || !res.body) {
		throw new Error(`Google Drive returned HTTP ${res.status}`);
	}

	const total = Number(res.headers.get('content-length')) || 0;
	const startedAt = Date.now();

	job.sizeBytes = 0;
	job.totalBytes = total || null;

	const counter = new Transform({
		transform(chunk, encoding, callback) {
			job.sizeBytes += chunk.length;
			job.progress = total ? Math.min(1, job.sizeBytes / total) : null;

			const seconds = (Date.now() - startedAt) / 1000;

			job.speed = seconds > 0.5 ? `${(job.sizeBytes / seconds / 1024 / 1024).toFixed(1)} MB/s` : null;
			callback(null, chunk);
		},
	});

	await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(partPath), { signal });
}
