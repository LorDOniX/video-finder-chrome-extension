// Česká televize (ceskatelevize.cz) – yt-dlp's extractor doesn't work with the current web.
// The page gives the IDEC of the video, the player API returns an HLS stream for it, which is then
// downloaded by ffmpeg (hls.js).

const API_URL = 'https://api.ceskatelevize.cz/video/v1/playlist-vod/v1/stream-data/media/external/';
// The web is behind a WAF that rejects requests without browser-like headers.
const BROWSER_HEADERS = {
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8',
};
// IDEC – 15 digit ID of a programme, e.g. /porady/871835-mach-a-sebestova/282350993581001/
const PATH_IDEC_RE = /\/(\d{15})(?:\/|$)/;
const IDEC_RE = /^\d{15}$/;
const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

export function isCeskaTelevizeUrl(url) {
	try {
		const { protocol, hostname } = new URL(url);

		return (protocol === 'https:' || protocol === 'http:') && /(^|\.)ceskatelevize\.cz$/i.test(hostname);
	} catch (e) {
		return false;
	}
}

async function fetchChecked(url, signal, headers) {
	const res = await fetch(url, { headers, signal });

	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${url}`);
	}

	return res;
}

/** IDEC of the video on the page: episode page -> the episode, show page -> the "play" button (film / first episode). */
async function findIdec(pageUrl, signal) {
	const pathMatch = PATH_IDEC_RE.exec(new URL(pageUrl).pathname);

	if (pathMatch) {
		return pathMatch[1];
	}

	const html = await (await fetchChecked(pageUrl, signal, BROWSER_HEADERS)).text();
	const json = NEXT_DATA_RE.exec(html)?.[1];

	if (!json) {
		throw new Error(/Request Rejected/i.test(html) ? 'Request rejected by ceskatelevize.cz' : 'No video data found on the page');
	}

	const { data, extra } = JSON.parse(json).props?.pageProps || {};
	const idec = [extra?.idec, data?.episode?.idec, data?.programme?.actionButton?.idec].find(id => IDEC_RE.test(id || ''));

	if (!idec) {
		throw new Error('No playable video found on the page');
	}

	return idec;
}

function videoTitle(data, idec) {
	const parts = [data.showTitle, data.episodeTitle].filter(Boolean).join(' | ') || data.title || idec;

	return parts.split(/\s*\|\s*/).filter(Boolean).join(' - ');
}

/**
 * Finds the video of a ceskatelevize.cz page.
 * Returns { url, title, durationSec } – url is an HLS stream (master playlist) for ffmpeg.
 */
export async function fetchCeskaTelevizeVideo(pageUrl, signal) {
	const idec = await findIdec(pageUrl, signal);
	const params = new URLSearchParams({ canPlayDrm: 'false', streamType: 'hls', quality: 'web', maxQualityCount: '5' });
	const res = await fetch(`${API_URL}${idec}?${params}`, { headers: { accept: 'application/json' }, signal });

	if (!res.ok) {
		throw new Error(res.status === 404 ? `Video ${idec} not found` : `Player API: HTTP ${res.status}`);
	}

	const data = await res.json();
	const stream = data.streams?.find(s => typeof s.url === 'string');

	if (!stream) {
		throw new Error(`Video ${idec} is not available (no stream)`);
	}

	if (new URL(stream.url).searchParams.get('drmOnly') === 'true') {
		throw new Error(`Video ${idec} is DRM protected`);
	}

	return {
		url: stream.url,
		title: videoTitle(data, idec),
		durationSec: Number(stream.duration ?? data.duration) || null,
	};
}
