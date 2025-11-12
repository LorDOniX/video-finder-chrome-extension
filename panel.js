const videoList = document.getElementById('videoList');
const refreshBtn = document.getElementById('refreshBtn');
const copyAllBtn = document.getElementById('copyAllBtn');
const downloadBtn = document.getElementById('downloadBtn');
const searchBox = document.getElementById('searchBox');
const emptyMsg = document.getElementById('empty');
const previewModal = document.getElementById('previewModal');
const previewVideo = document.getElementById('previewVideo');

const SCAN_VIDEOS = `Array.from(document.querySelectorAll('video')).flatMap(v => {
	const srcs = [];

	if (v.src) {
		srcs.push(v.src);
	}

	v.querySelectorAll('source').forEach(s => s.src && srcs.push(s.src));
		return srcs;
	}).filter(Boolean)`;
const urls = new Set();
const thumbnailsCache = new Map();
let filtered = [];

// Generate a thumbnail from a video URL
function generateThumbnail(url) {
	if (thumbnailsCache.has(url)) {
		return thumbnailsCache.get(url);
	}

	const container = document.createElement('div');

	container.style.width = '120px';
	container.style.height = '70px';
	container.style.flexShrink = 0;
	container.style.background = '#111';
	container.style.display = 'flex';
	container.style.alignItems = 'center';
	container.style.justifyContent = 'center';
	container.style.borderRadius = '4px';
	container.style.overflow = 'hidden';
	container.style.marginRight = '8px';

	try {
		const video = document.createElement('video');

		video.src = url;
		video.crossOrigin = 'anonymous';
		video.muted = true;
		video.playsInline = true;

		const seekTo = 1.5;

		video.addEventListener('loadedmetadata', () => {
			// seek to user defined timestamp (in seconds) if possible
			setTimeout(() => {
				video.currentTime = seekTo;
			}, 200);
		});
		// extract video thumbnail once seeking is complete
		video.addEventListener('seeked', () => {
			const canvas = document.createElement('canvas');

			canvas.style.objectFit = "contain";
			canvas.style.width = "100%";
			canvas.style.height = "100%";
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;

			const ctx = canvas.getContext('2d');

			ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
			container.appendChild(canvas);
			video.remove();
		});

		// Fallback in case metadata fails
		video.addEventListener('error', () => {
			container.textContent = '⚠';
			container.style.color = '#f88';
		});
	} catch (e) {
		container.textContent = '⚠';
		container.style.color = '#f88';
	}

	thumbnailsCache.set(url, container);

	return container;
}

function copyText(text) {
	//Create a textbox field where we can insert text to.
	var copyFrom = document.createElement("textarea");

	//Set the text content to be the text you wished to copy.
	copyFrom.textContent = text;

	//Append the textbox field into the body as a child.
	//"execCommand()" only works when there exists selected text, and the text is inside
	//document.body (meaning the text is part of a valid rendered HTML element).
	document.body.appendChild(copyFrom);

	//Select all the text!
	copyFrom.select();

	//Execute command
	document.execCommand('copy');

	//(Optional) De-select the text using blur().
	copyFrom.blur();

	//Remove the textbox field from the document.body, so no other JavaScript nor
	//other elements can get access to this.
	document.body.removeChild(copyFrom);
}

function renderList() {
	videoList.innerHTML = '';

	const query = searchBox.value.trim().toLowerCase();
	filtered = Array.from(urls).filter(u => u.toLowerCase().includes(query));

	if (filtered.length === 0) {
		emptyMsg.style.display = 'block';
		return;
	} else {
		emptyMsg.style.display = 'none';
	}

	filtered.forEach(url => {
		const li = document.createElement('li');

		// Thumbnail container
		const thumbContainer = generateThumbnail(url);

		// URL div (click to copy)
		const urlDiv = document.createElement('div');
		urlDiv.className = 'url';
		urlDiv.textContent = url;
		urlDiv.onclick = () => copyText(url);

		// Preview button (optional)
		const btn = document.createElement('button');
		btn.className = 'preview-btn';
		btn.textContent = '▶ Preview';
		btn.onclick = (e) => {
			e.stopPropagation();
			showPreview(url);
		};

		li.appendChild(thumbContainer);
		li.appendChild(urlDiv);
		li.appendChild(btn);
		li.style.display = 'flex';
		li.style.alignItems = 'center';
		li.style.gap = '8px';

		videoList.appendChild(li);
	});
}

function showPreview(url) {
	previewVideo.src = url;
	previewModal.style.display = 'flex';
}

previewModal.onclick = (e) => {
	if (e.target === previewModal) {
		previewModal.style.display = 'none';
		previewVideo.pause();
		previewVideo.src = '';
	}
};

function addVideoUrl(url) {
	if (!url || urls.has(url)) return;

	urls.add(url);
	renderList();
}

function clearList() {
	urls.clear();
	renderList();
}

// Scan <video> and <source> elements
function scanVideos() {
	chrome.devtools.inspectedWindow.eval(
		SCAN_VIDEOS,
		(result, isException) => {
			if (!isException && result) {
				result.forEach(addVideoUrl);
			}
		}
	);
}

// Watch network requests for video/MSE content
chrome.devtools.network.onRequestFinished.addListener(request => {
	const url = request.request.url;

	if (/\.(mp4|webm|m3u8|mov|avi|flv|mkv|mpd|m4s|ts)(\?|$)/i.test(url) || url.startsWith('blob:')) {
		addVideoUrl(url);
	}
});

// Inject MutationObserver and URL.createObjectURL hook
function injectObserver() {
	chrome.devtools.inspectedWindow.eval(`
		(function() {
		const port = chrome.runtime.connect({ name: "video-observer" });

		const sendVideos = () => {
			const vids = Array.from(document.querySelectorAll('video, source'))
			.map(v => v.src)
			.filter(Boolean);
			port.postMessage({ videos: vids });
		};

		const observer = new MutationObserver(sendVideos);
		observer.observe(document.body, { childList: true, subtree: true });

		const orig = URL.createObjectURL;
		URL.createObjectURL = function(...args) {
			try {
			const url = orig.apply(this, args);
			if (url.startsWith('blob:')) {
				port.postMessage({ videos: [url] });
			}
			return url;
			} catch (e) {
			return orig.apply(this, args);
			}
		};

		sendVideos();
		})();
	`);
}

function clearData() {
	clearList();
	scanVideos();
}

// Handle messages from the inspected page
chrome.runtime.onConnect.addListener(port => {
	if (port.name === "video-observer") {

		port.onMessage.addListener(msg => {
			if (msg.videos) {
				msg.videos.forEach(addVideoUrl);
			}
		});
	}
});

chrome.devtools.network.onNavigated.addListener(() => {
	clearData();
	injectObserver();
});

// Copy all URLs
copyAllBtn.onclick = () => {
	if (urls.size === 0) {
		return;
	}

	const all = Array.from(urls).join('\n');

	navigator.clipboard.writeText(all);
	copyAllBtn.textContent = "✅ Copied!";
	setTimeout(() => (copyAllBtn.textContent = "📋 Copy All"), 1500);
};

// Export URLs as .txt
downloadBtn.onclick = () => {
	if (urls.size === 0) {
		return;
	}

	const blob = new Blob([Array.from(urls).join('\n')], { type: 'text/plain' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');

	a.href = url;
	a.download = 'video_urls.txt';
	a.click();
	URL.revokeObjectURL(url);
};

// Manual refresh
refreshBtn.onclick = () => {
	clearData();
};

// Search filter
searchBox.oninput = renderList;

// Initial run
scanVideos();
renderList();
