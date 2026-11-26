const driveForm = document.getElementById('driveForm');
const driveUrl = document.getElementById('driveUrl');
const driveExtensions = document.getElementById('driveExtensions');
const driveBtn = document.getElementById('driveBtn');
const driveMessage = document.getElementById('driveMessage');

const DEFAULT_EXTENSIONS = '.gpx, .gp';
const EXTENSIONS_KEY = 'driveExtensions';
const DRIVE_FOLDER_RE = /^https:\/\/drive\.google\.com\/.*(\/folders\/|[?&]id=)/;

function showMessage(text, type = '') {
	driveMessage.textContent = text;
	driveMessage.className = type;
}

driveExtensions.value = localStorage.getItem(EXTENSIONS_KEY) || DEFAULT_EXTENSIONS;

// Prefill the URL when the popup is opened on a Drive folder.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
	if (!driveUrl.value && tab?.url && DRIVE_FOLDER_RE.test(tab.url)) {
		driveUrl.value = tab.url;
	}

	driveUrl.focus();
});

driveForm.onsubmit = async e => {
	e.preventDefault();

	const url = driveUrl.value.trim();
	const extensions = driveExtensions.value.trim() || DEFAULT_EXTENSIONS;

	if (!url) {
		showMessage('Paste a Google Drive folder URL.', 'error');
		driveUrl.focus();
		return;
	}

	localStorage.setItem(EXTENSIONS_KEY, extensions);
	driveBtn.disabled = true;
	showMessage('Searching the folder…');

	try {
		const { downloads } = await serverFetch('/drive', {
			method: 'POST',
			body: JSON.stringify({ url, extensions }),
		});

		showMessage(`Found ${downloads.length} file(s): ${downloads.map(d => d.fileName).join(', ')}`, 'ok');
		pollDownloads();
	} catch (err) {
		showMessage(err instanceof TypeError ? 'Server offline – run `npm run server` in WSL.' : err.message, 'error');
	} finally {
		driveBtn.disabled = false;
	}
};

pollDownloads();
