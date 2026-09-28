// Publica en Discord (vía webhook) las noticias nuevas de World of Warcraft (es-MX).
// Uso: node src/index.js [--dry-run]

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'state.json');

const BASE_URL = 'https://worldofwarcraft.blizzard.com';
const LIST_URL = `${BASE_URL}/es-mx/news`;
const USER_AGENT =
  'wow-noticias-es/1.0 (+https://github.com/TiagoAG26/wow-noticias-es; Discord news relay)';

const MAX_PER_RUN = 5;
const DELAY_BETWEEN_MESSAGES_MS = 2000;
const MAX_STATE_IDS = 300;
const DESCRIPTION_MAX = 300;
const MAX_429_RETRIES = 5;

const COLORS = {
  hotfixes: 0xed4245,
  patchNotes: 0xe67e22,
  weekly: 0xf0b132,
  default: 0x5865f2,
};

const DRY_RUN = process.argv.includes('--dry-run');
const WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_NEWS || '').trim();
const ROLE_ID = (process.env.DISCORD_ROLE_ID || '').trim();
const AVATAR_URL = (process.env.DISCORD_AVATAR_URL || '').trim();
const EXCLUDE_PATCH_NOTES = /^(1|true|yes|si|sí)$/i.test(
  (process.env.EXCLUDE_PATCH_NOTES || 'false').trim(),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minúsculas y sin tildes, para comparar títulos.
const normalize = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const absoluteUrl = (u) => {
  if (!u) return null;
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `${BASE_URL}${u}`;
  return u;
};

const truncate = (s, max) => {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};

// Falla pasajera (red, timeout, 5xx, 429): no se reintenta acá, lo hace la
// próxima ejecución programada. El job termina OK para no mandar un mail.
class TransientError extends Error {}

async function fetchText(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es-MX,es;q=0.9' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new TransientError(`Error de red al pedir ${url}: ${err.cause?.code || err.message}`);
  }
  if (!res.ok) {
    const msg = `HTTP ${res.status} al pedir ${url}`;
    if (res.status >= 500 || res.status === 429 || res.status === 408) throw new TransientError(msg);
    throw new Error(msg);
  }
  return res.text();
}

// ─── Fuente ──────────────────────────────────────────────────────────────────

// El listado trae embebido <script id="model">model = {...};</script> con los
// artículos en JSON (render del servidor). Es más estable que las tarjetas HTML.
function parseListing(html) {
  const m = html.match(/<script[^>]*\bid="model"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No se encontró el bloque <script id="model"> en el listado');
  const json = m[1].trim().replace(/^model\s*=\s*/, '').replace(/;\s*$/, '');
  const blogs = JSON.parse(json)?.blogList?.blogs;
  if (!Array.isArray(blogs)) throw new Error('El modelo no contiene blogList.blogs');

  const seen = new Set();
  const articles = [];
  for (const b of blogs) {
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id) || b.draft) continue;
    seen.add(id);
    articles.push({
      id,
      title: String(b.title || '').trim(),
      description: String(b.description || '').trim(),
      published: b.published || null,
      url: `${BASE_URL}/es-mx/news/${id}/${b.slug || ''}`.replace(/\/$/, ''),
      image: absoluteUrl(b.image?.url || b.thumbnail?.url),
    });
  }
  return articles;
}

function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : null;
}

// Completa el artículo con los datos de su página (og:*) y el hilo del foro.
// Si la página falla, se sigue con lo que vino en el listado.
async function enrichArticle(article) {
  try {
    const html = await fetchText(article.url);
    const ogTitle = metaContent(html, 'og:title');
    const ogDesc = metaContent(html, 'og:description') || metaContent(html, 'description');
    const ogImage = metaContent(html, 'og:image');
    const ogUrl = metaContent(html, 'og:url');
    // El link de comentarios es el <a> que envuelve el contador "CommentTotal".
    const forum =
      html.match(
        /href="(https:\/\/us\.forums\.blizzard\.com\/es\/wow\/t\/[^"]+)"[^>]*>\s*<div class="CommentTotal/,
      )?.[1] ||
      html.match(
        /class="[^"]*Button--social[^"]*"[^>]*href="(https:\/\/us\.forums\.blizzard\.com\/es\/wow\/t\/[^"]+)"/,
      )?.[1] ||
      null;

    return {
      ...article,
      title: ogTitle ? ogTitle.replace(/\s+-\s+WoW$/, '') : article.title,
      description: ogDesc || article.description,
      image: absoluteUrl(ogImage) || article.image,
      url: article.url || ogUrl,
      forumUrl: forum ? decodeEntities(forum) : null,
    };
  } catch (err) {
    console.warn(`⚠️  No se pudo leer el artículo ${article.id}: ${err.message}. Uso datos del listado.`);
    return { ...article, forumUrl: null };
  }
}

// ─── Embed ───────────────────────────────────────────────────────────────────

function colorFor(title) {
  const t = normalize(title);
  if (t.includes('hotfixes')) return COLORS.hotfixes;
  if (t.includes('notas de la actualizacion')) return COLORS.patchNotes;
  if (t.includes('resumen semanal')) return COLORS.weekly;
  return COLORS.default;
}

function isPatchNotes(title) {
  const t = normalize(title);
  return t.startsWith('hotfixes') || t.startsWith('notas de la actualizacion');
}

function buildPayload(a) {
  const embed = {
    title: truncate(a.title, 256),
    url: a.url,
    description: truncate(a.description || '', DESCRIPTION_MAX) || undefined,
    color: colorFor(a.title),
    image: a.image ? { url: a.image } : undefined,
    timestamp: a.published || undefined,
    footer: { text: 'Blizzard Entertainment • Fuente oficial' },
  };
  if (a.forumUrl) {
    embed.fields = [{ name: '💬 Foros', value: `[Comentar en los foros](${a.forumUrl})` }];
  }

  const payload = {
    username: 'Noticias WoW',
    embeds: [embed],
    allowed_mentions: { parse: [] }, // por defecto: no mencionar a nadie
  };
  if (AVATAR_URL) payload.avatar_url = AVATAR_URL;
  if (/^\d{5,25}$/.test(ROLE_ID)) {
    payload.content = `<@&${ROLE_ID}>`;
    payload.allowed_mentions = { parse: [], roles: [ROLE_ID] };
  } else if (ROLE_ID) {
    console.warn('⚠️  DISCORD_ROLE_ID no es un ID numérico válido; se publica sin mención.');
  }
  return payload;
}

// ─── Discord ─────────────────────────────────────────────────────────────────

async function postToDiscord(payload) {
  const url = new URL(WEBHOOK_URL);
  url.searchParams.set('wait', 'true');

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    if (res.ok) return;

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const seconds = Number(body.retry_after ?? res.headers.get('retry-after') ?? 2);
      const waitMs = Math.ceil((Number.isFinite(seconds) ? seconds : 2) * 1000) + 250;
      console.warn(`⏳ Discord 429 (rate limit). Reintento en ${waitMs} ms…`);
      await sleep(waitMs);
      continue;
    }

    const text = await res.text().catch(() => '');
    throw new Error(`Discord respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new Error('Discord siguió respondiendo 429 tras varios reintentos');
}

// ─── Estado ──────────────────────────────────────────────────────────────────

async function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  const data = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  return { published: Array.isArray(data.published) ? data.published.map(Number) : [] };
}

async function saveState(ids) {
  const unique = [...new Set(ids)].slice(-MAX_STATE_IDS);
  await writeFile(STATE_FILE, `${JSON.stringify({ published: unique }, null, 2)}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const byDateAsc = (a, b) =>
  (Date.parse(a.published) || 0) - (Date.parse(b.published) || 0) || a.id - b.id;

async function main() {
  if (!DRY_RUN && !WEBHOOK_URL) {
    throw new Error('Falta la variable DISCORD_WEBHOOK_NEWS (o usá --dry-run).');
  }

  let articles;
  try {
    articles = parseListing(await fetchText(LIST_URL));
  } catch (err) {
    const msg = `No se pudo leer el listado de noticias: ${err.message}`;
    throw err instanceof TransientError ? new TransientError(msg) : new Error(msg);
  }
  if (articles.length === 0) {
    throw new Error('El listado de noticias devolvió 0 artículos. No se modifica el estado.');
  }
  console.log(`📰 ${articles.length} artículos en la primera página.`);

  const state = await loadState();
  const seed = state === null;
  const known = new Set(state?.published ?? []);
  const eligible = (a) => !(EXCLUDE_PATCH_NOTES && isPatchNotes(a.title));

  let toPublish;
  let registerWithoutPosting; // ids que se marcan como vistos sin publicarse

  if (seed) {
    // Primera ejecución: se registra todo y solo se publica el más reciente.
    const newest = [...articles].filter(eligible).sort(byDateAsc).at(-1);
    toPublish = newest ? [newest] : [];
    registerWithoutPosting = articles.filter((a) => a !== newest).map((a) => a.id);
    console.log(`🌱 Modo SEED: no existe state.json. Se registran ${articles.length} ids y se publica solo el más reciente.`);
  } else {
    const fresh = articles.filter((a) => !known.has(a.id));
    // Los excluidos se marcan como vistos para no publicarlos más adelante.
    registerWithoutPosting = fresh.filter((a) => !eligible(a)).map((a) => a.id);
    toPublish = fresh.filter(eligible).sort(byDateAsc).slice(0, MAX_PER_RUN);
    const pendingLeft = fresh.filter(eligible).length - toPublish.length;
    console.log(`🆕 ${fresh.length} nuevos (${registerWithoutPosting.length} excluidos). A publicar ahora: ${toPublish.length}${pendingLeft > 0 ? ` (quedan ${pendingLeft} para la próxima)` : ''}.`);
  }

  const enriched = [];
  for (const a of toPublish) enriched.push(await enrichArticle(a));

  if (DRY_RUN) {
    console.log('\n🧪 --dry-run: no se envía nada a Discord ni se modifica state.json.\n');
    for (const a of enriched) {
      console.log(`• [${a.id}] ${a.title}`);
      console.log(`  Publicado: ${a.published}`);
      console.log(`  URL:       ${a.url}`);
      console.log(`  Foro:      ${a.forumUrl ?? '(sin hilo)'}`);
      console.log('  Payload:');
      console.log(JSON.stringify(buildPayload(a), null, 2).replace(/^/gm, '    '));
      console.log();
    }
    if (enriched.length === 0) console.log('Nada para publicar.');
    return;
  }

  const ids = [...(state?.published ?? []), ...registerWithoutPosting];
  let failures = 0;

  for (let i = 0; i < enriched.length; i++) {
    const a = enriched[i];
    if (i > 0) await sleep(DELAY_BETWEEN_MESSAGES_MS);
    try {
      await postToDiscord(buildPayload(a));
      ids.push(a.id);
      console.log(`✅ Publicado [${a.id}] ${a.title}`);
    } catch (err) {
      failures++;
      console.error(`❌ Falló [${a.id}] ${a.title}: ${err.message}`);
    }
  }

  const before = JSON.stringify(state?.published ?? null);
  await saveState(ids);
  const after = JSON.stringify((await loadState()).published);
  console.log(before === after ? '💾 state.json sin cambios.' : '💾 state.json actualizado.');

  if (failures > 0) {
    throw new Error(`${failures} publicación(es) fallaron; se reintentarán en la próxima ejecución.`);
  }
}

main().catch((err) => {
  if (err instanceof TransientError) {
    // Anotación visible en GitHub Actions; el estado no se tocó.
    console.log(`::warning::${err.message}. Se reintenta en la próxima ejecución.`);
    return;
  }
  console.error(`\n🚨 ERROR: ${err.message}`);
  process.exit(1);
});
