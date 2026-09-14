import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();

const APK_PATH = new URL('./public/firetvplayer.apk', import.meta.url).pathname;

// Download diretto dell'APK per l'installazione su altri Fire TV Stick.
// Endpoint dedicato (invece di affidarsi solo a express.static) cosi'
// Content-Disposition/Content-Type sono espliciti: alcuni download manager
// su Fire TV (incluso "Downloader" di AFTVnews) interrompono o mostrano
// l'installazione come fallita se questi header mancano o sono ambigui,
// anche quando il file scaricato e' in realta' completo.
app.get('/apk', (req, res) => {
  res.download(APK_PATH, 'firetvplayer.apk', {
    headers: { 'Content-Type': 'application/vnd.android.package-archive' },
  }, (err) => {
    if (err) console.error(`[apk download] ${err.message}`);
  });
});

// Pagina intermedia: utile da un browser normale, ma su Fire TV conviene
// inserire direttamente l'URL /apk nell'app Downloader.
app.get('/download', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>FireTVPlayer - Download</title>
  <style>
    body { background:#0e1116; color:#f2f4f7; font-family: -apple-system, sans-serif; text-align:center; padding: 60px 20px; }
    a.btn { display:inline-block; margin-top:24px; padding:16px 32px; background:#ff8c1a; color:#0e1116; font-weight:bold; font-size:20px; text-decoration:none; border-radius:8px; }
    p { color:#a9b2c0; font-size:16px; }
    code { background:#1a1f27; padding:2px 8px; border-radius:4px; }
  </style>
</head>
<body>
  <h1>FireTVPlayer</h1>
  <p>Apri questa pagina dal browser del Fire TV Stick (o dall'app "Downloader")<br>e scarica l'APK per installarlo.</p>
  <a class="btn" href="/apk">Scarica APK</a>
  <p style="margin-top:32px">Nell'app <b>Downloader</b>, inserisci direttamente:<br><code>${req.protocol}://${req.get('host')}/apk</code></p>
</body>
</html>`);
});

app.use(express.static('public'));

const M3U8_REGEX = /\.m3u8(\?|$)/i;
const PLAYLIST_REGEX = /vixcloud\.co\/playlist\//i;

async function resolveFromPage(gotoUrl, { clickPlay = true } = {}) {
  let browser;
  const capturedRequests = [];
  let foundUrl = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
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

    // Intercetta le richieste di TUTTI i frame (main + iframe vixcloud)
    page.on('request', (request) => {
      const reqUrl = request.url();
      capturedRequests.push(reqUrl);
      if (!foundUrl && (M3U8_REGEX.test(reqUrl) || PLAYLIST_REGEX.test(reqUrl))) {
        foundUrl = reqUrl;
        console.log(`  ✓✓✓ Intercettata richiesta: ${reqUrl}`);
      }
    });

    console.log(`  ⏳ Navigando (sessione reale) a: ${gotoUrl}`);
    await page.goto(gotoUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch((e) => {
      console.log(`  ⚠️  goto warning: ${e.message}`);
    });

    // Prova a cliccare eventuali pulsanti "play" nella pagina principale e negli iframe
    if (clickPlay) {
      const tryClick = async (frame) => {
        try {
          await frame.evaluate(() => {
            const sels = ['.vjs-big-play-button', '.jw-icon-playback', '[aria-label="Play"]', '.play-button', 'video', 'button'];
            for (const sel of sels) {
              document.querySelectorAll(sel).forEach((el) => { try { el.click(); } catch (e) {} });
            }
          });
        } catch (e) { /* frame potrebbe non essere accessibile */ }
      };
      await tryClick(page);
      // Aspetta che gli iframe (vixcloud embed) si carichino
      await new Promise((r) => setTimeout(r, 2000));
      for (const frame of page.frames()) {
        await tryClick(frame);
      }
    }

    // Aspetta fino a 20s per la richiesta m3u8/playlist
    const maxWaitMs = 20000;
    const stepMs = 500;
    let waited = 0;
    while (!foundUrl && waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, stepMs));
      waited += stepMs;
      // Ritenta il click ogni tanto (il player potrebbe caricarsi in ritardo)
      if (clickPlay && waited % 3000 === 0) {
        for (const frame of page.frames()) {
          try {
            await frame.evaluate(() => {
              document.querySelectorAll('video, .vjs-big-play-button, .jw-icon-playback').forEach((el) => { try { el.click(); } catch (e) {} });
            });
          } catch (e) { /* ignore */ }
        }
      }
    }

    // Fallback: cerca nel DOM di tutti i frame
    let domUrl = null;
    if (!foundUrl) {
      for (const frame of page.frames()) {
        try {
          const html = await frame.content();
          const m3u8Match = html.match(/(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/);
          if (m3u8Match) { domUrl = m3u8Match[1]; break; }
          const playlistMatch = html.match(/(https?:\/\/vixcloud\.co\/playlist\/[^\s"'<>\\]+)/);
          if (playlistMatch) { domUrl = playlistMatch[1]; break; }
        } catch (e) { /* frame non accessibile (cross-origin) */ }
      }
    }

    const finalUrl = foundUrl || domUrl;

    if (!finalUrl) {
      const title = await page.title().catch(() => '');
      const frameUrls = page.frames().map((f) => f.url());
      console.log(`  📄 Title: "${title}"`);
      console.log(`  📄 Frames: ${JSON.stringify(frameUrls)}`);
    }

    return { finalUrl, capturedRequests, frameCount: page.frames().length };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}

// Endpoint principale: risolve navigando l'intero flusso (watch page -> iframe -> playlist)
// dentro un'unica sessione browser, come farebbe un utente reale.
app.get('/resolve-watch', async (req, res) => {
  const { baseUrl, titleId, episodeId } = req.query;

  if (!baseUrl || !titleId) {
    return res.json({ success: false, error: 'baseUrl and titleId parameters required' });
  }

  const watchUrl = episodeId
    ? `${baseUrl}/it/watch/${titleId}?e=${episodeId}`
    : `${baseUrl}/it/watch/${titleId}`;

  console.log(`[${new Date().toISOString()}] Resolve-watch: ${watchUrl}`);

  try {
    const { finalUrl, capturedRequests, frameCount } = await resolveFromPage(watchUrl);
    if (finalUrl) {
      console.log(`  ✓✓✓ TROVATA: ${finalUrl}`);
      res.json({ success: true, playlistUrl: finalUrl });
    } else {
      console.log(`  ❌ Non trovata (${capturedRequests.length} richieste, ${frameCount} frame)`);
      res.json({ success: false, error: 'Playlist URL not found', requestsSeen: capturedRequests.length, frameCount });
    }
  } catch (error) {
    console.error(`  ❌ Errore: ${error.message}`);
    res.json({ success: false, error: error.message });
  }
});

// Endpoint legacy: risolve partendo direttamente dall'URL embed vixcloud
// (mantenuto per compatibilita' / debug, ma soggetto a 403 se manca la sessione reale).
app.get('/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.json({ error: 'URL parameter required' });
  }
  console.log(`[${new Date().toISOString()}] Resolve (legacy): ${url}`);
  try {
    const { finalUrl, capturedRequests } = await resolveFromPage(url, { clickPlay: true });
    if (finalUrl) {
      res.json({ success: true, playlistUrl: finalUrl });
    } else {
      res.json({ success: false, error: 'Playlist URL not found', requestsSeen: capturedRequests.length });
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    endpoints: [
      '/resolve-watch?baseUrl=<streamingcommunity_base>&titleId=<id>&episodeId=<optional>',
      '/resolve?url=<vixcloud_embed_url>'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
