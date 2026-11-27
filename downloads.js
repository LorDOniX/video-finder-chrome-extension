// Downloads list of the local download server – shared by the DevTools panel and the popup.
// Expects #downloadList, #downloadsEmpty, #serverStatus and #clearDownloadsBtn in the page (see downloads.css).
const downloadList = document.getElementById('downloadList');
const downloadsEmpty = document.getElementById('downloadsEmpty');
const serverStatus = document.getElementById('serverStatus');
const clearDownloadsBtn = document.getElementById('clearDownloadsBtn');

// Local download server running in WSL (see server/index.js, `npm run server`).
const SERVER_URL = 'http://localhost:9787';
const ACTIVE_STATUSES = ['queued', 'downloading', 'canceling'];

// download id -> <li> in the downloads list
const downloadItems = new Map();
let pollTimer = null;
let pollInFlight = false;
let pollRequested = false;

async function serverFetch(path, options = {}) {
	const headers = options.body ? { 'Content-Type': 'application/json' } : {};
	const res = await fetch(SERVER_URL + path, { ...options, headers, cache: 'no-store' });
	const data = await res.json().catch(() => ({}));

	if (!res.ok) {
		throw new Error(data.error || `HTTP ${res.status}`);
	}

	return data;
}

function removeServerDownload(id) {
	return serverFetch(`/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' })
		.catch(e => console.warn('Server request failed:', e))
		.finally(pollDownloads);
}

function formatTime(sec) {
	const total = Math.floor(sec || 0);
	const h = Math.floor(total / 3600);
	const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
	const s = String(total % 60).padStart(2, '0');

	return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function formatSize(bytes) {
	if (!bytes) {
		return '0 MB';
	}

	if (bytes < 1024 ** 2) {
		return `${Math.max(1, Math.round(bytes / 1024))} kB`;
	}

	return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function downloadInfo(d) {
	switch (d.status) {
		case 'queued':
			return 'Waiting in queue…';
		case 'downloading': {
			const parts = [];

			if (d.progress !== null) {
				parts.push(`${Math.floor(d.progress * 100)} %`);
			}

			if (d.kind === 'hls') {
				parts.push(d.durationSec ? `${formatTime(d.downloadedSec)} / ${formatTime(d.durationSec)}` : formatTime(d.downloadedSec));
				parts.push(formatSize(d.sizeBytes));
			} else {
				parts.push(d.totalBytes ? `${formatSize(d.sizeBytes)} / ${formatSize(d.totalBytes)}` : formatSize(d.sizeBytes));
			}

			if (d.speed) {
				parts.push(d.speed);
			}

			if (d.note) {
				parts.push(d.note);
			}

			return parts.join(' · ');
		}
		case 'done':
			return d.kind === 'hls'
				? `✅ Done · ${formatSize(d.sizeBytes)} · ${formatTime(d.durationSec || d.downloadedSec)}`
				: `✅ Done · ${formatSize(d.sizeBytes)}`;
		case 'canceling':
			return 'Canceling…';
		case 'canceled':
			return 'Canceled';
		default:
			return `⚠ ${d.error || 'Download failed'}`;
	}
}

function createDownloadItem(id) {
	const li = document.createElement('li');
	const main = document.createElement('div');
	const name = document.createElement('div');
	const bar = document.createElement('div');
	const fill = document.createElement('div');
	const info = document.createElement('div');
	const btn = document.createElement('button');

	main.className = 'dl-main';
	name.className = 'dl-name';
	bar.className = 'dl-bar';
	fill.className = 'dl-bar-fill';
	info.className = 'dl-info';
	btn.className = 'preview-btn';
	btn.onclick = () => {
		btn.disabled = true;
		removeServerDownload(id);
	};

	bar.appendChild(fill);
	main.append(name, bar, info);
	li.append(main, btn);
	li._els = { name, fill, info, btn };

	return li;
}

function renderDownloads(downloads) {
	const ids = new Set(downloads.map(d => d.id));

	for (const [id, li] of downloadItems) {
		if (!ids.has(id)) {
			li.remove();
			downloadItems.delete(id);
		}
	}

	// Server returns newest first.
	downloads.forEach((d, index) => {
		let li = downloadItems.get(d.id);

		if (!li) {
			li = createDownloadItem(d.id);
			downloadItems.set(d.id, li);
		}

		if (downloadList.children[index] !== li) {
			downloadList.insertBefore(li, downloadList.children[index] || null);
		}

		const { name, fill, info, btn } = li._els;
		const active = ACTIVE_STATUSES.includes(d.status);
		const indeterminate = d.status === 'downloading' && d.progress === null;

		li.className = `dl-${d.status}`;
		name.textContent = d.fileName;
		name.title = `${d.filePath}\n${d.url}`;
		fill.classList.toggle('indeterminate', indeterminate);
		fill.style.width = indeterminate ? '' : `${Math.round((d.status === 'done' ? 1 : d.progress || 0) * 100)}%`;
		info.textContent = downloadInfo(d);
		btn.textContent = active ? '✖ Cancel' : '🗑 Remove';
		btn.disabled = d.status === 'canceling';
		btn.title = active ? 'Cancel download' : 'Remove from list (keeps the file)';
	});

	downloadsEmpty.style.display = downloads.length === 0 ? 'block' : 'none';
	clearDownloadsBtn.disabled = !downloads.some(d => !ACTIVE_STATUSES.includes(d.status));
}

function setServerStatus(online, error) {
	serverStatus.className = online ? 'online' : 'offline';
	serverStatus.textContent = online ? '● server online' : '● server offline – run `npm run server` in WSL';
	serverStatus.title = online ? SERVER_URL : `${SERVER_URL}: ${error || ''}`;
}

async function pollDownloads() {
	if (pollInFlight) {
		// Refresh again once the running request finishes (e.g. right after starting a download).
		pollRequested = true;
		return;
	}

	clearTimeout(pollTimer);
	pollInFlight = true;

	let active = false;

	try {
		const { downloads } = await serverFetch('/downloads');

		setServerStatus(true);
		renderDownloads(downloads);
		active = downloads.some(d => ACTIVE_STATUSES.includes(d.status));
	} catch (e) {
		setServerStatus(false, e.message);
		clearDownloadsBtn.disabled = true;
	} finally {
		pollInFlight = false;
		// Fast refresh while something is downloading, otherwise just a health check.
		pollTimer = setTimeout(pollDownloads, pollRequested ? 0 : active ? 1000 : 5000);
		pollRequested = false;
	}
}

// Removes finished downloads from the list (files stay on disk), running ones are kept.
clearDownloadsBtn.onclick = () => {
	clearDownloadsBtn.disabled = true;
	serverFetch('/downloads', { method: 'DELETE' })
		.catch(e => console.warn('Server request failed:', e))
		.finally(pollDownloads);
};
