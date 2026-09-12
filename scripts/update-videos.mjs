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
}

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
