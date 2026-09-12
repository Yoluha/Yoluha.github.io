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

// ---------- YouTube (full video catalog, unofficial internal API, no key needed) ----------
const YT_WEB_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const YT_WEB_CLIENT_VERSION = '2.20260908.00.00';
const VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

async function ytBrowse(body) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${YT_WEB_API_KEY}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'CONSENT=YES+1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`YouTube browse failed: ${res.status}`);
  return res.json();
}

function parseViewCount(text) {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim().toLowerCase();
  const m = cleaned.match(/^([\d.]+)\s*([km]?)\s*views?$/);
  if (m) {
    let n = parseFloat(m[1]);
    if (m[2] === 'k') n *= 1000;
    if (m[2] === 'm') n *= 1000000;
    return Math.round(n);
  }
  return 0;
}

function genreFromTitleSuffix(title) {
  const parts = title.split('|').map(s => s.trim());
  if (parts.length < 2) return null;
  let genre = parts[1];
  if (!genre) return null;
  genre = genre.replace(/\s*playlist\s*$/i, '').trim();
  if (!genre || genre.length > 24) return null;
  const opens = (genre.match(/[({\[]/g) || []).length;
  const closes = (genre.match(/[)}\]]/g) || []).length;
  if (opens !== closes) return null;
  return genre;
}

function canonicalizeGenres(videos) {
  const canonical = new Map();
  for (const v of videos) {
    if (!v.genre) continue;
    const key = v.genre.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, v.genre);
  }
  for (const v of videos) {
    if (v.genre) v.genre = canonical.get(v.genre.toLowerCase());
  }
}

function extractLockups(items) {
  const out = [];
  for (const item of items) {
    const lvm = item.richItemRenderer?.content?.lockupViewModel;
    const meta = lvm?.metadata?.lockupMetadataViewModel;
    const title = meta?.title?.content;
    const id = lvm?.contentId;
    if (!id || !title) continue;
    const parts = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts || [];
    const viewsText = parts[0]?.text?.content || '';
    out.push({ id, title, views: parseViewCount(viewsText) });
  }
  return out;
}

function findContinuationToken(items) {
  for (const item of items) {
    const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) return token;
  }
  return null;
}

async function fetchAllVideos(channelId, maxPages = 40) {
  const context = { client: { clientName: 'WEB', clientVersion: YT_WEB_CLIENT_VERSION } };
  const data = await ytBrowse({ context, browseId: channelId, params: VIDEOS_TAB_PARAMS });
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  const tab = tabs.find(t => t.tabRenderer?.selected) || tabs.find(t => t.tabRenderer?.title === 'Videos');
  const items = tab?.tabRenderer?.content?.richGridRenderer?.contents || [];
  if (!items.length) throw new Error('no video items found on Videos tab');

  const all = extractLockups(items);
  let token = findContinuationToken(items);
  let pages = 1;

  while (token && pages < maxPages) {
    const cont = await ytBrowse({ context, continuation: token });
    const actions = cont?.onResponseReceivedActions || [];
    const appended = actions.flatMap(a => a.appendContinuationItemsAction?.continuationItems || []);
    if (!appended.length) break;
    all.push(...extractLockups(appended));
    token = findContinuationToken(appended);
    pages += 1;
  }
  return all;
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
  const rssEntries = parseEntries(xml);
  const rssById = new Map(rssEntries.map(e => [e.id, e]));

  let videos;
  try {
    const fullList = await fetchAllVideos(channelId);
    videos = fullList.map((v, i) => {
      const rss = rssById.get(v.id);
      return {
        id: v.id,
        title: v.title,
        genre: rss?.genre ?? genreFromTitleSuffix(v.title),
        views: v.views || rss?.views || 0,
        likes: rss?.likes || 0,
        order: i,
      };
    });
    canonicalizeGenres(videos);
    console.log(`${slug}: full catalog fetch got ${videos.length} videos`);
  } catch (err) {
    console.error(`${slug}: full video list fetch failed, falling back to RSS-only (15 latest):`, err.message);
    videos = rssEntries.map((e, i) => ({ ...e, order: i }));
  }

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
