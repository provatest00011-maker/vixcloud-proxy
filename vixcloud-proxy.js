import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();

const M3U8_REGEX = /\.m3u8(\?|$)/i;
const PLAYLIST_REGEX = /vixcloud\.co\/playlist\//i;

app.get('/resolve', async (req, res) => {
  const { url, debug } = req.query;

  if (!url) {
    return res.json({ error: 'URL parameter required' });
  }

  console.log(`[${new Date().toISOString()}] Risolvendo: ${url}`);

  let browser;
  let responded = false;
  const send = (payload) => {
    if (!responded) {
      responded = true;
      res.json(payload);
    }
  };

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    let foundUrl = null;
    const capturedRequests = [];

    // Intercetta TUTTE le richieste di rete della pagina
    page.on('request', (request) => {
      const reqUrl = request.url();
      capturedRequests.push(reqUrl);
      if (!foundUrl && (M3U8_REGEX.test(reqUrl) || PLAYLIST_REGEX.test(reqUrl))) {
        foundUrl = reqUrl;
        console.log(`  ✓✓✓ Intercettata richiesta rete: ${reqUrl}`);
      }
    });

    console.log(`  ⏳ Caricando pagina...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
      console.log(`  ⚠️  goto warning: ${e.message}`);
    });

    // Prova a cliccare play se c'è un pulsante overlay (alcuni player richiedono interazione)
    try {
      await page.evaluate(() => {
        const playSelectors = ['.vjs-big-play-button', '.jw-icon-playback', '[aria-label="Play"]', '.play-button', 'video'];
        for (const sel of playSelectors) {
          const el = document.querySelector(sel);
          if (el) { el.click?.(); }
        }
      });
    } catch (e) { /* ignore */ }

    // Aspetta fino a 15 secondi per la richiesta m3u8/playlist, controllando ogni 500ms
    const maxWaitMs = 15000;
    const stepMs = 500;
    let waited = 0;
    while (!foundUrl && waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, stepMs));
      waited += stepMs;
    }

    // Fallback: cerca anche nel DOM/HTML se la network capture non ha trovato nulla
    let domUrl = null;
    if (!foundUrl) {
      domUrl = await page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        const m3u8Match = html.match(/(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/);
        if (m3u8Match) return m3u8Match[1];
        const playlistMatch = html.match(/(https?:\/\/vixcloud\.co\/playlist\/[^\s"'<>\\]+)/);
        if (playlistMatch) return playlistMatch[1];
        return null;
      }).catch(() => null);
    }

    const finalUrl = foundUrl || domUrl;

    if (debug === '1') {
      const html = await page.content().catch(() => '');
      await browser.close();
      browser = null;
      return send({
        success: !!finalUrl,
        playlistUrl: finalUrl,
        debug: {
          capturedRequestsCount: capturedRequests.length,
          capturedRequestsSample: capturedRequests.slice(-40),
          htmlLength: html.length,
          htmlSnippet: html.slice(0, 3000)
        }
      });
    }

    await browser.close();
    browser = null;

    if (finalUrl) {
      console.log(`  ✓✓✓ TROVATA: ${finalUrl}`);
      send({ success: true, playlistUrl: finalUrl });
    } else {
      console.log(`  ❌ URL non trovata (network: ${capturedRequests.length} richieste, nessun match)`);
      send({ success: false, error: 'Playlist URL not found (network+DOM)', requestsSeen: capturedRequests.length });
    }
  } catch (error) {
    console.error(`  ❌ Errore: ${error.message}`);
    send({ success: false, error: error.message });
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
  res.json({ status: 'ok', endpoint: '/resolve?url=<vixcloud_url>&debug=1' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
