#!/usr/bin/env node

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Dedicated, unlisted ClubDesk page that hosts only the press file list.
// Visitors see the cards on /der_club; this page exists purely so the
// scraper has a stable, focused data source.
const OSCA_URL = 'https://www.osca.ch/der_club/press_list_for_scraping';
const OUTPUT_FILE = path.join(__dirname, '../docs/press.json');
const CARDS_FILE = path.join(__dirname, '../docs/cards.html');

async function scrapeOSCA() {
  console.log(`Fetching: ${OSCA_URL}`);
  const response = await axios.get(OSCA_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const $ = cheerio.load(response.data);

  // The osca.ch page sets <base href="/clubdesk/w_OSCA/"/>, which means
  // relative URLs like `fileservlet?...` must resolve against that prefix.
  // Without this, we'd produce https://www.osca.ch/fileservlet?... (404).
  const baseHref = $('base[href]').attr('href');
  const baseUrl = baseHref ? new URL(baseHref, OSCA_URL).href : OSCA_URL;

  // Scope to ClubDesk file-list blocks (data-block-type="3"). Every press
  // file is rendered inside one of these; favicons, hero images, and footer
  // logos live in other block types and are therefore excluded automatically.
  const fileListBlocks = $('[data-block-type="3"]');
  if (fileListBlocks.length === 0) {
    throw new Error('No ClubDesk file list block (data-block-type="3") found on page');
  }

  const files = [];

  fileListBlocks.each((_, block) => {
    const $block = $(block);

    // (1) Plain hyperlinks to ClubDesk files, e.g. <a href="fileservlet?...">
    $block.find('a[href*="fileservlet"]').each((_, el) => {
      const $a = $(el);
      files.push(buildFile($a.attr('href'), titleFromAnchor($a), baseUrl));
    });

    // (2) ClubDesk file-list rows render as <tr onclick="window.open('fileservlet?...', '_blank')">.
    // The filename lives in a non-icon <td> in the same row.
    $block.find('[onclick*="fileservlet"]').each((_, el) => {
      const $row = $(el);
      const onclick = $row.attr('onclick') || '';
      const match = onclick.match(/window\.open\(\s*['"]([^'"]+)['"]/);
      if (!match) return;
      const filename = $row.find('td.cd-table-value').not('.cd-icon').first().text().trim();
      files.push(buildFile(match[1], filename, baseUrl));
    });
  });

  const uniqueFiles = Array.from(new Map(files.map(f => [f.url, f])).values());

  const output = {
    lastUpdated: new Date().toISOString(),
    source: OSCA_URL,
    count: uniqueFiles.length,
    files: uniqueFiles
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✓ Wrote ${uniqueFiles.length} files to ${OUTPUT_FILE}`);

  // SEO snippet: HTML for pasting into the ClubDesk HTML block on osca.ch.
  // Files sharing a stem (e.g. foo.pdf + foo.jpg) become one article — JPG as
  // thumbnail, PDF as the link target — so Google indexes the article text on
  // osca.ch itself rather than on github.io.
  const articles = buildArticles(uniqueFiles);
  fs.writeFileSync(CARDS_FILE, renderCardsPage(articles, output.lastUpdated));
  console.log(`✓ Wrote ${articles.length} cards to ${CARDS_FILE}`);
}

function buildFile(rawUrl, title, baseUrl) {
  const absoluteUrl = new URL(rawUrl, baseUrl).href;
  return {
    title: title || 'Pressemitteilung',
    url: absoluteUrl,
    type: classify(absoluteUrl, title)
  };
}

// Decide how index.html should render the card. Prefer the actual filename
// extension when we have it (a ClubDesk type=file can still be a .jpg);
// fall back to the URL's `type` query param.
function classify(absoluteUrl, title) {
  const lowerTitle = (title || '').toLowerCase();
  if (/\.(jpe?g|png|webp|gif)$/.test(lowerTitle)) return 'image';
  if (lowerTitle.endsWith('.pdf')) return 'pdf';
  const typeParam = new URL(absoluteUrl).searchParams.get('type');
  if (typeParam === 'image') return 'image';
  return 'clubdesk';
}

function titleFromAnchor($a) {
  const text = $a.text().trim();
  if (text) return text;
  const alt = ($a.find('img').attr('alt') || '').trim();
  return alt;
}

// ---------- Article grouping & cards.html rendering ----------

// Group files into "articles" by filename stem. A stem with both .pdf and
// .jpg becomes one article: JPG as thumbnail, PDF as the link target.
function buildArticles(files) {
  const groups = new Map();
  for (const f of files) {
    const stem = f.title.replace(/\.[a-z0-9]+$/i, '');
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(f);
  }

  const articles = [];
  for (const [stem, group] of groups) {
    const jpg = group.find(f => f.type === 'image');
    const pdf = group.find(f => f.type === 'pdf');
    const fallback = group[0];
    articles.push({
      stem,
      articleUrl: (pdf || jpg || fallback).url,
      thumbUrl: jpg ? jpg.url : null,
      kind: pdf ? 'pdf' : (jpg ? 'image' : 'other'),
      ...parseFilename(stem)
    });
  }

  // Newest first; unparseable dates last.
  articles.sort((a, b) => {
    if (a.isoDate && b.isoDate) return b.isoDate.localeCompare(a.isoDate);
    if (a.isoDate) return -1;
    if (b.isoDate) return 1;
    return 0;
  });
  return articles;
}

// Convention: YYYY-MM-DD-source-rest-of-name. Falls through gracefully if
// the filename doesn't match — we just show the raw stem as headline.
function parseFilename(stem) {
  const m = stem.match(/^(\d{4})-(\d{2})-(\d{2})-([a-z0-9]+)-(.+)$/i);
  if (!m) return { isoDate: null, dateLabel: null, source: null, headline: stem };
  const [, y, mo, d, src, rest] = m;
  return {
    isoDate: `${y}-${mo}-${d}`,
    dateLabel: formatDateDe(y, mo, d),
    source: capitalize(src),
    headline: rest.split('-').map(capitalize).join(' ')
  };
}

function formatDateDe(y, mo, d) {
  const months = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
  ];
  return `${parseInt(d, 10)}. ${months[parseInt(mo, 10) - 1]} ${y}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])
  );
}

function renderCard(article) {
  const headline = escapeHtml(article.headline);
  const articleUrl = escapeHtml(article.articleUrl);
  const linkLabel = article.kind === 'pdf' ? 'PDF öffnen' : 'Artikel öffnen';

  let metaLine = '';
  if (article.source && article.dateLabel) {
    metaLine = `<span itemprop="publisher" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">${escapeHtml(article.source)}</span></span> &middot; <time itemprop="datePublished" datetime="${escapeHtml(article.isoDate)}">${escapeHtml(article.dateLabel)}</time>`;
  } else if (article.source) {
    metaLine = `<span itemprop="publisher" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">${escapeHtml(article.source)}</span></span>`;
  } else if (article.dateLabel) {
    metaLine = `<time itemprop="datePublished" datetime="${escapeHtml(article.isoDate)}">${escapeHtml(article.dateLabel)}</time>`;
  }

  const visual = article.thumbUrl
    ? `<a href="${articleUrl}" target="_blank" rel="noopener" style="display:block;text-decoration:none;"><img src="${escapeHtml(article.thumbUrl)}" alt="${headline}" itemprop="image" style="display:block;width:100%;height:180px;object-fit:cover;background:#f5f5f5;" /></a>`
    : `<a href="${articleUrl}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;height:180px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white;text-decoration:none;font-size:56px;">📄</a>`;

  return `<article itemscope itemtype="https://schema.org/NewsArticle" style="flex:0 1 300px;min-width:260px;display:flex;flex-direction:column;border:1px solid #e0e0e0;border-radius:12px;overflow:hidden;background:white;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
${visual}
<div style="padding:14px 18px;flex:1;display:flex;flex-direction:column;">
${metaLine ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#777;margin-bottom:6px;">${metaLine}</div>` : ''}
<h3 itemprop="headline" style="margin:0 0 10px 0;font-size:17px;line-height:1.3;color:#222;">${headline}</h3>
<a href="${articleUrl}" target="_blank" rel="noopener" itemprop="url" style="margin-top:auto;font-weight:bold;color:#0066cc;text-decoration:none;font-size:14px;">${linkLabel} &rarr;</a>
</div>
</article>`;
}

function renderCardsPage(articles, lastUpdated) {
  // Wrap all cards in a flex container so they sit side-by-side on wide
  // screens and wrap to fewer per row on narrow screens — no media queries
  // needed (ClubDesk's HTML block strips <style>; flex-wrap handles it).
  const cardsHtml = articles.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:center;align-items:stretch;margin:24px 0;">
${articles.map(renderCard).join('\n')}
</div>`
    : '<p style="text-align:center;color:#999;padding:40px;">Noch keine Pressemitteilungen.</p>';

  const updatedLabel = new Date(lastUpdated).toLocaleString('de-CH', {
    dateStyle: 'short', timeStyle: 'short'
  });

  // Hidden textarea holds the raw snippet so a "Copy" button can place it on
  // the clipboard; the same HTML is also rendered visibly above for preview.
  const escapedSnippet = escapeHtml(cardsHtml);

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OSCA Presse – Snippet zum Einfügen</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; padding: 20px; color: #222; max-width: 800px; margin: 0 auto; }
  .instructions { padding: 16px 20px; background: #fff8dc; border-left: 4px solid #f0ad4e; border-radius: 4px; margin-bottom: 24px; }
  .instructions h1 { margin: 0 0 8px; font-size: 18px; }
  .instructions p, .instructions ol { margin: 8px 0; font-size: 14px; line-height: 1.5; }
  .instructions code { background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .copy-btn { display: inline-block; padding: 10px 18px; background: #0066cc; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; }
  .copy-btn:hover { background: #0052a3; }
  .copy-status { margin-left: 12px; font-size: 14px; color: #2e7d32; }
  .updated { font-size: 12px; color: #999; margin-bottom: 8px; }
  .preview-label { font-size: 13px; color: #999; text-transform: uppercase; letter-spacing: 1px; margin: 32px 0 8px; }
</style>
</head>
<body>
  <div class="instructions">
    <h1>HTML-Snippet für osca.ch</h1>
    <p>Klicken Sie auf <strong>Snippet kopieren</strong>, dann auf osca.ch in den HTML-Block der Sektion «OSCA in den Medien» einfügen.</p>
    <p>
      <button class="copy-btn" onclick="copySnippet()">📋 Snippet kopieren</button>
      <span id="copy-status" class="copy-status"></span>
    </p>
    <p style="font-size:12px;color:#666;">Diese Seite wird alle 6 Stunden automatisch aktualisiert. Nach dem Hochladen einer neuen Pressedatei in ClubDesk dauert es bis zu 6 Stunden, bis hier die neue Karte erscheint.</p>
  </div>

  <div class="updated">Zuletzt aktualisiert: ${updatedLabel} · ${articles.length} Artikel</div>

  <div class="preview-label">Vorschau</div>
<!-- BEGIN PASTE -->
${cardsHtml}
<!-- END PASTE -->

  <textarea id="snippet" hidden>${escapedSnippet}</textarea>
  <script>
    function copySnippet() {
      var ta = document.getElementById('snippet');
      var status = document.getElementById('copy-status');
      navigator.clipboard.writeText(ta.value).then(function () {
        status.textContent = '✓ Kopiert!';
        setTimeout(function () { status.textContent = ''; }, 3000);
      }).catch(function () {
        status.textContent = '⚠ Bitte den Quelltext zwischen den BEGIN/END-Markern manuell kopieren.';
      });
    }
  </script>
</body>
</html>`;
}

scrapeOSCA().catch(err => {
  console.error('Error scraping OSCA:', err.message);
  process.exit(1);
});
