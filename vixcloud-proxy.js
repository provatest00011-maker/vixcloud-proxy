import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();

app.get('/resolve', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.json({ error: 'URL parameter required' });
  }

  console.log(`[${new Date().toISOString()}] Risolvendo: ${url}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Setta User-Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    console.log(`  ⏳ Caricando pagina (timeout: 30s)...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    console.log(`  ✓ Pagina caricata, cercando playlist URL...`);

    const playlistUrl = await page.evaluate(() => {
      const html = document.documentElement.outerHTML;

      // 1. Pattern m3u8
      const m3u8Match = html.match(/(https:\/\/[^\s"'<>&]+\.m3u8[^\s"'<>&]*)/);
      if (m3u8Match) return { url: m3u8Match[1], pattern: 'm3u8' };

      // 2. Pattern vixcloud/playlist
      const playlistMatch = html.match(/(https:\/\/vixcloud\.co\/playlist\/[^\s"'<>&]+)/);
      if (playlistMatch) return { url: playlistMatch[1], pattern: 'playlist' };

      return null;
    });

    await browser.close();
    browser = null;

    if (playlistUrl) {
      console.log(`  ✓✓✓ TROVATA (${playlistUrl.pattern}): ${playlistUrl.url}`);
      res.json({ success: true, playlistUrl: playlistUrl.url });
    } else {
      console.log(`  ❌ URL non trovata nel DOM`);
      res.json({ success: false, error: 'Playlist URL not found in page' });
    }
  } catch (error) {
    console.error(`  ❌ Errore: ${error.message}`);
    res.json({ success: false, error: error.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', endpoint: '/resolve?url=<vixcloud_url>' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
