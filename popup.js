const videoForm = document.getElementById('videoForm');
const videoUrl = document.getElementById('videoUrl');
const videoBtn = document.getElementById('videoBtn');
const videoMessage = document.getElementById('videoMessage');
const driveForm = document.getElementById('driveForm');
const driveUrl = document.getElementById('driveUrl');
const driveExtensions = document.getElementById('driveExtensions');
const driveBtn = document.getElementById('driveBtn');
const driveMessage = document.getElementById('driveMessage');

const DEFAULT_EXTENSIONS = '.gpx, .gp';
const EXTENSIONS_KEY = 'driveExtensions';
const DRIVE_FOLDER_RE = /^https:\/\/drive\.google\.com\/.*(\/folders\/|[?&]id=)/;
const OFFLINE_MESSAGE = 'Server offline – run `npm run server` in WSL.';

function showMessage(el, text, type = '') {
	el.textContent = text;
	el.className = `message ${type}`;
}

driveExtensions.value = localStorage.getItem(EXTENSIONS_KEY) || DEFAULT_EXTENSIONS;

// Prefill the URL of the current tab: Drive folder -> Drive form, any other web page -> video form.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
	const url = tab?.url || '';

	if (DRIVE_FOLDER_RE.test(url)) {
		driveUrl.value ||= url;
		driveUrl.focus();
		return;
	}

	if (/^https?:\/\//.test(url)) {
		videoUrl.value ||= url;
	}

	videoUrl.focus();
	videoUrl.select();
});

videoForm.onsubmit = async e => {
	e.preventDefault();

	const url = videoUrl.value.trim();

	if (!url) {
		showMessage(videoMessage, 'Paste a video URL.', 'error');
		videoUrl.focus();
		return;
	}

	videoBtn.disabled = true;
	showMessage(videoMessage, 'Fetching video info…');

	try {
		const { download } = await serverFetch('/ytdlp', {
			method: 'POST',
			body: JSON.stringify({ url }),
		});

		showMessage(videoMessage, `Downloading: ${download.fileName}`, 'ok');
		pollDownloads();
	} catch (err) {
		showMessage(videoMessage, err instanceof TypeError ? OFFLINE_MESSAGE : err.message, 'error');
	} finally {
		videoBtn.disabled = false;
	}
};

driveForm.onsubmit = async e => {
	e.preventDefault();

	const url = driveUrl.value.trim();
	const extensions = driveExtensions.value.trim() || DEFAULT_EXTENSIONS;

	if (!url) {
		showMessage(driveMessage, 'Paste a Google Drive folder URL.', 'error');
		driveUrl.focus();
		return;
	}

	localStorage.setItem(EXTENSIONS_KEY, extensions);
	driveBtn.disabled = true;
	showMessage(driveMessage, 'Searching the folder…');

	try {
		const { downloads } = await serverFetch('/drive', {
			method: 'POST',
			body: JSON.stringify({ url, extensions }),
		});

		showMessage(driveMessage, `Found ${downloads.length} file(s): ${downloads.map(d => d.fileName).join(', ')}`, 'ok');
		pollDownloads();
	} catch (err) {
		showMessage(driveMessage, err instanceof TypeError ? OFFLINE_MESSAGE : err.message, 'error');
	} finally {
		driveBtn.disabled = false;
	}
};

pollDownloads();
