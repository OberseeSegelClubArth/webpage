#!/usr/bin/env node

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const OSCA_URL = 'https://www.osca.ch/der_club';
const OUTPUT_FILE = path.join(__dirname, '../docs/press.json');
const SECTION_HEADING = 'OSCA in den Medien';

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

  // Locate the section that contains the "OSCA in den Medien" heading,
  // so we never pick up logos, hero images, or footer files from other parts of the page.
  const heading = $('h1, h2, h3, h4').filter((_, el) =>
    $(el).text().trim() === SECTION_HEADING
  ).first();

  if (heading.length === 0) {
    throw new Error(`Heading "${SECTION_HEADING}" not found on page`);
  }

  const section = heading.closest('[id^="section_"]');
  if (section.length === 0) {
    throw new Error(`Section wrapper for "${SECTION_HEADING}" not found`);
  }

  const files = [];

  // (1) Plain hyperlinks to ClubDesk files, e.g. <a href="fileservlet?type=image&id=...">
  section.find('a[href*="fileservlet"]').each((_, el) => {
    const $a = $(el);
    files.push(buildFile($a.attr('href'), titleFromAnchor($a), baseUrl));
  });

  // (2) ClubDesk file-list rows render as <tr onclick="window.open('fileservlet?...', '_blank')">.
  // The filename lives in a non-icon <td> in the same row.
  section.find('[onclick*="fileservlet"]').each((_, el) => {
    const $row = $(el);
    const onclick = $row.attr('onclick') || '';
    const match = onclick.match(/window\.open\(\s*['"]([^'"]+)['"]/);
    if (!match) return;
    const filename = $row.find('td.cd-table-value').not('.cd-icon').first().text().trim();
    files.push(buildFile(match[1], filename, baseUrl));
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

scrapeOSCA().catch(err => {
  console.error('Error scraping OSCA:', err.message);
  process.exit(1);
});
