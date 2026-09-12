import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CHANNELS = [
  { slug: 'yoshiki-beats', channelId: 'UClEkyF0yv7Vyh2nRhKlvFlQ' },
  { slug: 'synth-yoshi', channelId: 'UC0ohsreRvQ0-QZ0dYdq9Rrg' },
];

function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`feed fetch failed for ${channelId}: ${res.status}`);
  return res.text();
}

function parseEntries(xml) {
  const entries = [];
  const blocks = xml.split('<entry>').slice(1);
  for (const block of blocks) {
    const idMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = block.match(/<title>([^<]*)<\/title>/);
    const publishedMatch = block.match(/<published>([^<]+)<\/published>/);
    const descMatch = block.match(/<media:description>([^<]*)</);
    const viewsMatch = block.match(/<media:statistics views="(\d+)"/);
    const likesMatch = block.match(/<media:starRating[^>]*count="(\d+)"/);
    if (!idMatch || !titleMatch) continue;

    let genre = null;
    if (descMatch) {
      const desc = decodeXml(descMatch[1]);
      const pipeIdx = desc.indexOf('|');
      if (pipeIdx > 0 && pipeIdx < 40) genre = desc.slice(0, pipeIdx).trim();
    }

    entries.push({
      id: idMatch[1],
      title: decodeXml(titleMatch[1]),
      published: publishedMatch ? publishedMatch[1] : null,
      genre,
      views: viewsMatch ? Number(viewsMatch[1]) : 0,
      likes: likesMatch ? Number(likesMatch[1]) : 0,
    });
  }
  return entries;
}

// ---------- YouTube Music (unofficial internal API, no key needed) ----------
const YTM_API_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';
const YTM_CLIENT_VERSION = '1.20260908.14.00';

async function ytMusicBrowse(browseId) {
  const res = await fetch(`https://music.youtube.com/youtubei/v1/browse?key=${YTM_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'CONSENT=YES+1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: YTM_CLIENT_VERSION, hl: 'en' } },
      browseId,
    }),
  });
  if (!res.ok) throw new Error(`YT Music browse failed for ${browseId}: ${res.status}`);
  return res.json();
}

function parseGenreFromTitle(title) {
  const m = title.match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : null;
}

function parsePlays(text) {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim().toLowerCase();
  const m = cleaned.match(/^([\d.]+)\s*([km]?)\s*plays?$/);
  if (m) {
    let n = parseFloat(m[1]);
    if (m[2] === 'k') n *= 1000;
    if (m[2] === 'm') n *= 1000000;
    return Math.round(n);
  }
  const digits = cleaned.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

async function fetchSongs(channelId) {
  const overview = await ytMusicBrowse(channelId);
  const sections = overview?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
  const shelf = sections.map(s => s.musicShelfRenderer).find(Boolean);
  if (!shelf) return [];

  let items = shelf.contents || [];
  const seeAllId = shelf.bottomEndpoint?.browseEndpoint?.browseId;
  if (seeAllId) {
    const full = await ytMusicBrowse(seeAllId);
    const playlistShelf = full?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer;
    if (playlistShelf?.contents) items = playlistShelf.contents;
  }

  const songs = [];
  for (const it of items) {
    const r = it.musicResponsiveListItemRenderer;
    if (!r) continue;
    const cols = r.flexColumns || [];
    const title = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join('') || null;
    const playsText = cols[2]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(x => x.text).join('') || '';
    let videoId = null;
    try {
      videoId = r.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchEndpoint.videoId;
    } catch (e) { /* no play button on this row */ }
    if (!title || !videoId) continue;
    songs.push({ id: videoId, title, genre: parseGenreFromTitle(title), plays: parsePlays(playsText) });
  }
  return songs;
}

let changed = false;
for (const { slug, channelId } of CHANNELS) {
  const xml = await fetchFeed(channelId);
  const videos = parseEntries(xml);
  const outPath = path.join(ROOT, slug, 'videos.json');
  const next = JSON.stringify(videos, null, 2) + '\n';
  const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (next !== prev) {
    fs.writeFileSync(outPath, next);
    changed = true;
    console.log(`Updated ${slug}/videos.json (${videos.length} videos)`);
  } else {
    console.log(`${slug}/videos.json unchanged (${videos.length} videos)`);
  }

  try {
    const songs = await fetchSongs(channelId);
    const songsPath = path.join(ROOT, slug, 'songs.json');
    const nextSongs = JSON.stringify(songs, null, 2) + '\n';
    const prevSongs = fs.existsSync(songsPath) ? fs.readFileSync(songsPath, 'utf8') : '';
    if (nextSongs !== prevSongs) {
      fs.writeFileSync(songsPath, nextSongs);
      changed = true;
      console.log(`Updated ${slug}/songs.json (${songs.length} songs)`);
    } else {
      console.log(`${slug}/songs.json unchanged (${songs.length} songs)`);
    }
  } catch (err) {
    console.error(`Skipped ${slug}/songs.json:`, err.message);
  }
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
