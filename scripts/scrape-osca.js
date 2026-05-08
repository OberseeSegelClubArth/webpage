#!/usr/bin/env node

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const OSCA_URL = 'https://www.osca.ch/der_club';
const OUTPUT_FILE = path.join(__dirname, '../docs/press.json');

// Image and PDF file extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const PDF_EXTENSION = '.pdf';

async function scrapeOSCA() {
  try {
    console.log(`Fetching: ${OSCA_URL}`);
    const response = await axios.get(OSCA_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const files = [];

    // Find the "OSCA in den Medien" section
    // Look for headings that contain "OSCA in den Medien"
    const mediaSection = $('*').filter((i, el) => {
      const text = $(el).text();
      return text.includes('OSCA in den Medien');
    }).first();

    if (mediaSection.length === 0) {
      console.warn('Warning: "OSCA in den Medien" section not found');
    }

    // Get all links on the page (in case we need to search more broadly)
    const allLinks = $('a[href]');

    allLinks.each((index, element) => {
      const $link = $(element);
      const href = $link.attr('href');
      const linkText = $link.text().trim();

      if (!href || !linkText) return;

      // Check if link is a file we care about
      const lowerHref = href.toLowerCase();
      
      // Check for image files
      const isImage = IMAGE_EXTENSIONS.some(ext => lowerHref.endsWith(ext));
      
      // Check for PDF files
      const isPDF = lowerHref.endsWith(PDF_EXTENSION);
      
      // Check for ClubDesk file links
      const isClubDesk = href.includes('/clubdesk/w_OSCA/fileservlet');

      if (isImage || isPDF || isClubDesk) {
        // Make relative URLs absolute if needed
        let absoluteUrl = href;
        if (!href.startsWith('http')) {
          if (href.startsWith('/')) {
            absoluteUrl = new URL(href, OSCA_URL).href;
          } else {
            absoluteUrl = new URL(href, OSCA_URL).href;
          }
        }

        files.push({
          title: linkText,
          url: absoluteUrl,
          type: isImage ? 'image' : isPDF ? 'pdf' : 'clubdesk',
          extension: isImage ? 
            IMAGE_EXTENSIONS.find(ext => lowerHref.endsWith(ext)) : 
            isPDF ? PDF_EXTENSION : 'clubdesk'
        });
      }
    });

    // Remove duplicates based on URL
    const uniqueFiles = Array.from(
      new Map(files.map(file => [file.url, file])).values()
    );

    // Prepare output
    const output = {
      lastUpdated: new Date().toISOString(),
      source: OSCA_URL,
      count: uniqueFiles.length,
      files: uniqueFiles
    };

    // Ensure docs directory exists
    const docsDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    // Write to file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`✓ Successfully wrote ${uniqueFiles.length} files to ${OUTPUT_FILE}`);
    console.log(`Last updated: ${output.lastUpdated}`);

  } catch (error) {
    console.error('Error scraping OSCA:', error.message);
    process.exit(1);
  }
}

scrapeOSCA();
