// Records the live DARWIN app with a scripted cursor, a zooming camera and a spotlight, paced to the narration.
// Usage: node record.mjs <narration.json> <durations.json> <outdir>    (REHEARSE=1: do not fire the shock)
// durations.json: {id: seconds} for every line in narration.json. One more line, s4_quote, reads the Claude reason
// shown at record time; its slot is sized from its word count (WPS) and it is synthesised after the take
// (scenes.json info.s4_quote holds its text and caption). A line's "gap_after" adds silence after it.
// Writes <outdir>/frames/*.jpg, frames.json, scenes.json.
//
// Camera: the page is never scrolled. A CSS transform on <body> (origin 0 0) zooms and pans to the focus, with
// eased ~600 ms moves; the cursor dot and the spotlight live on <html>, outside the transform.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');

const URL = 'https://near-darwin.onrender.com/';
const PAD = 0.35;            // breath after each line
const WPS = +(process.env.WPS || 2.4); // words a second of the voice; re-measure from the TTS durations
const MAX_QUOTE_WORDS = 19;  // a decision holds 8 s on screen; the quote must be read inside that
const lines = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const dur = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = process.argv[4];
const gap = Object.fromEntries(lines.map((l) => [l.id, l.gap_after || 0]));
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
// The dashboard renders history only (no live stream) for a HeadlessChrome user agent.
await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('darwin-tour-seen', '1'); } catch {}
  window.__aiLog = [];
  addEventListener('DOMContentLoaded', () => {
    const root = document.documentElement, body = document.body;
    const d = document.createElement('div');
    d.id = '__cursor';
    d.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;' +
      'background:rgba(235,235,235,.55);border:2px solid #111;box-shadow:0 0 0 1px rgba(255,255,255,.6);z-index:2147483647;' +
      'pointer-events:none;transform:translate(960px,540px)';
    const spot = document.createElement('div');
    spot.id = '__spot';
    spot.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;border-radius:14px;pointer-events:none;z-index:2147483600;' +
      'opacity:0;box-shadow:0 0 0 1px rgba(255,255,255,.22),0 0 0 3000px rgba(0,0,0,.62),0 0 40px 12px rgba(0,0,0,.4) inset;' +
      'transition-property:left,top,width,height,opacity;transition-timing-function:cubic-bezier(.65,0,.35,1)';
    root.appendChild(spot); root.appendChild(d);
    root.style.background = getComputedStyle(body).backgroundColor;
    body.style.transformOrigin = '0 0';
    body.style.willChange = 'transform';
    body.style.transitionProperty = 'transform';
    body.style.transitionTimingFunction = 'cubic-bezier(.65,0,.35,1)';
    addEventListener('mousemove', (e) => { if (e.isTrusted) d.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => { d.style.background = 'rgba(0,200,120,.85)'; }, true);
    addEventListener('mouseup', () => { setTimeout(() => (d.style.background = 'rgba(235,235,235,.55)'), 180); }, true);
    const why = document.getElementById('ai-why');
    if (why) new MutationObserver(() => window.__aiLog.push({ t: Date.now() / 1000, why: why.innerText })).observe(why, { childList: true, characterData: true, subtree: true });

    // Camera state and moves.
    const cam = { s: 1, tx: 0, ty: 0 };
    const W = innerWidth, H = innerHeight, CAP = 120; // keep the focus clear of the caption band
    const find = (sel, text) => {
      let el = document.querySelector(sel);
      if (el && text) {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n; el = null;
        while ((n = w.nextNode())) if (n.textContent.includes(text) && n.parentElement.offsetParent) { el = n.parentElement; break; }
      }
      return el;
    };
    // Untransformed page rect of the union of [sel, text] targets.
    const pageRect = (targets) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [sel, text] of targets) {
        const el = find(sel, text);
        if (!el) throw new Error(`not found: ${sel} ${text || ''}`);
        const r = el.getBoundingClientRect();
        x0 = Math.min(x0, (r.left - cam.tx) / cam.s); y0 = Math.min(y0, (r.top - cam.ty) / cam.s);
        x1 = Math.max(x1, (r.right - cam.tx) / cam.s); y1 = Math.max(y1, (r.bottom - cam.ty) / cam.s);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    window.__cam = {
      // Frame the targets: scale to fit (capped at maxScale), centre them above the captions, dim the rest.
      focus(targets, { maxScale = 1.4, minScale = 1, pad = 24, spot: dim = true, ms } = {}) {
        const r = pageRect(targets);
        const docH = root.scrollHeight;
        const s = Math.max(minScale, Math.min(maxScale, (W - 160) / (r.w + 2 * pad), (H - CAP - 100) / (r.h + 2 * pad)));
        let tx = W / 2 - s * (r.x + r.w / 2), ty = (H - CAP) / 2 - s * (r.y + r.h / 2);
        tx = Math.min(0, Math.max(W - s * W, tx));
        ty = Math.min(0, Math.max(H - s * docH, ty));
        const dist = Math.hypot(tx - cam.tx, ty - cam.ty) + 400 * Math.abs(s - cam.s);
        const t = ms ?? Math.round(Math.min(1500, Math.max(650, 500 + dist * 0.35)));
        body.style.transitionDuration = spot.style.transitionDuration = t + 'ms';
        body.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
        Object.assign(cam, { s, tx, ty });
        const vx = s * (r.x - pad) + tx, vy = s * (r.y - pad) + ty;
        Object.assign(spot.style, { left: vx + 'px', top: vy + 'px', width: s * (r.w + 2 * pad) + 'px', height: s * (r.h + 2 * pad) + 'px', opacity: dim ? '1' : '0' });
        return t;
      },
      wide(ms = 900) {
        body.style.transitionDuration = spot.style.transitionDuration = ms + 'ms';
        body.style.transform = 'translate(0px,0px) scale(1)';
        Object.assign(cam, { s: 1, tx: 0, ty: 0 });
        spot.style.opacity = '0';
        return ms;
      },
      state: () => ({ ...cam }),
    };
  });
});

for (let i = 0; i < 12; i++) {
  try { const r = await fetch(URL + 'api/state'); if (r.ok) break; } catch {}
  await sleep(10000);
}
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 180000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => +document.getElementById('tick').textContent.replace(/,/g, '') > 0 && document.getElementById('plot').dataset.state !== 'loading' && !document.getElementById('ai').hidden, { timeout: 120000 });
await sleep(2500);
// The run must be moving: a finished or stalled stream would freeze every scene.
{
  const tk = () => page.evaluate(() => +document.getElementById('tick').textContent.replace(/,/g, ''));
  const a = await tk(); await sleep(4000); const b = await tk();
  console.log('ticks', a, b);
  if (b <= a || b > 1500) { console.error('run not moving or too late:', a, b); await browser.close(); process.exit(2); }
}

// ---- camera, cursor ----
const focus = async (targets, opts = {}) => { const t = await page.evaluate((a, o) => window.__cam.focus(a, o), targets, opts); await sleep(t + 80); await page.mouse.move(mx, my); };
const wide = async (ms) => { const t = await page.evaluate((m) => window.__cam.wide(m), ms); await sleep(t + 80); await page.mouse.move(mx, my); };
let mx = 960, my = 540;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms = 700) {
  const x0 = mx, y0 = my, t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms), k = ease(t);
    await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
    if (t >= 1) break;
    await sleep(15);
  }
  mx = x; my = y;
}
// On-screen (transformed) rect of an element, or of the first element under it whose own text includes `text`.
async function rect(sel, text) {
  return page.evaluate((sel, text) => {
    let el = document.querySelector(sel);
    if (el && text) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; el = null;
      while ((n = w.nextNode())) if (n.textContent.includes(text) && n.parentElement.offsetParent) { el = n.parentElement; break; }
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, sel, text);
}
async function point(sel, text, ms = 700, dx = 0) {
  const r = await rect(sel, text);
  if (!r) throw new Error(`not found: ${sel} ${text || ''}`);
  await moveTo(dx ? r.x + dx : r.cx, r.cy, ms);
  return r;
}
async function click(sel, text) {
  await point(sel, text, 600);
  await sleep(200);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
}
const txt = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText || '', sel);

// ---- screencast ----
const cdp = await page.createCDPSession();
const frames = [];
let fi = 0;
cdp.on('Page.screencastFrame', async (f) => {
  const name = `f${String(fi++).padStart(6, '0')}.jpg`;
  fs.writeFileSync(path.join(out, 'frames', name), Buffer.from(f.data, 'base64'));
  frames.push({ name, t: f.metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await sleep(400);
await page.evaluate(() => {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:.01;z-index:2147483646;pointer-events:none';
  document.documentElement.appendChild(t);
  let k = 0; setInterval(() => { t.style.background = (k ^= 1) ? '#fff' : '#fefefe'; }, 33);
});
// Open on the chart, already zoomed in.
await page.evaluate(() => window.__cam.focus([['#plot']], { maxScale: 1.3, spot: false, ms: 1 }));
{ const a = await rect('#axis'); mx = a.x + 40; my = a.cy; }
await page.mouse.move(mx, my);
await sleep(500);
const T0 = Date.now() / 1000;
const scenes = [];
const info = {};
async function scene(id, fn) {
  const start = Date.now() / 1000;
  scenes.push({ id, start: start - T0 });
  console.log('scene', id, (start - T0).toFixed(2));
  await fn();
  const left = start + dur[id] + PAD + gap[id] - Date.now() / 1000;
  if (left > 0) await sleep(left * 1000);
}
const words = (q) => q.split(/\s+/).length;
const spoken = (q) => q.replace(/(\d+)\.(\d+)/g, (_, a, b) => `${a} point ${b.split('').join(' ')}`).replace(/(\d+)%/g, '$1 percent').replace(/\//g, ' or ');

try {
await sleep(400);
await scene('s0_hook', async () => {
  // Ride along the round axis, under the bands, so no tooltip covers the opening shot.
  const a = await rect('#axis');
  await moveTo(a.x + a.w * 0.3, a.cy, 1000);
  await moveTo(a.x + a.w - 40, a.cy, 4000);
});

await scene('s1_what', async () => {
  await focus([['.brand'], ['#plot']], { maxScale: 1.05, spot: false, ms: 1100 });
  await point('.wordmark', null, 800);
  await sleep(900);
  await point('#tagline', null, 900, 260);
  await sleep(1500);
  await point('#tagline', 'Claude', 900);
});

await scene('s2_chart', async () => {
  await focus([['#plot']], { maxScale: 1 });
  const m = await rect('#muller');
  await moveTo(m.x + 60, m.y + m.h * 0.3, 900);
  await moveTo(m.x + m.w * 0.6, m.y + m.h * 0.6, 2200);
});

await scene('s2_leader', async () => {
  const leader = (await txt('#headline')).match(/^a\d+/)?.[0];
  info.headline = await txt('#headline');
  const m = await rect('#muller');
  // Find the leader's band near the right edge with untrusted events (the cursor dot ignores them). The camera is
  // at scale 1 here, so the chart's own hit test lines up with the screen.
  const hit = await page.evaluate(async (m, leader) => {
    const c = document.getElementById('muller'), tip = document.getElementById('tip');
    const x = m.x + m.w - 160, ys = [];
    for (let y = m.y + 4; y < m.y + m.h - 30; y += 4) {
      c.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      const who = tip.hidden ? '' : (tip.querySelector('b')?.textContent || '');
      if (leader && who.startsWith(leader + '’')) ys.push(y);
    }
    c.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    return ys.length ? { x, y: ys[Math.floor(ys.length / 2)], n: ys.length } : { x, y: m.y + m.h * 0.5, n: 0 };
  }, m, leader);
  info.hit = hit;
  await moveTo(hit.x - 300, hit.y, 900);
  await moveTo(hit.x, hit.y, 1000);
  info.tip = await txt('#tip');
  await sleep(1200);
  await moveTo(hit.x - 120, hit.y + 6, 1500);
});

await scene('s3_why', async () => {
  await focus([['#take-h'], ['#take-body']], { maxScale: 1.5 });
  await point('#take-h', null, 700);
  await sleep(700);
  const b = await rect('#take-body');
  await moveTo(b.x + 30, b.y + b.h * 0.55, 700);
  await moveTo(b.x + b.w - 30, b.y + b.h * 0.75, 1800);
  info.take = await txt('#take-body');
});

await scene('s4_claude', async () => {
  await focus([['#ai']], { maxScale: 1.45 });
  await point('#ai-tag', null, 700);
  await sleep(700);
  await point('#ai-tag', 'recorded', 700, 140);
});
// Read the quote on a freshly shown decision (each holds 8 s), and only one short enough to read in that time.
for (let tries = 0; tries < 4; tries++) {
  const n0 = await page.evaluate(() => window.__aiLog.length);
  const t0 = Date.now();
  while (Date.now() - t0 < 25000 && (await page.evaluate(() => window.__aiLog.length)) === n0) await sleep(50);
  info.quote = (await txt('#ai-why')).trim().replace(/^[“"]|[”"]$/g, '');
  if (words(info.quote) <= MAX_QUOTE_WORDS) break;
}
info.aiWhat = await txt('#ai-what');
info.s4_quote = { id: 's4_quote', text: `This one says: ${spoken(info.quote)}`, caption: `This one says: “${info.quote}”` };
dur.s4_quote = words(info.s4_quote.text) / WPS + 0.2;
gap.s4_quote = 0;
await scene('s4_quote', async () => {
  const r = await rect('#ai-why');
  await moveTo(r.x + 20, r.y + 14, 500);
  await moveTo(r.x + Math.min(r.w, 900), r.y + (r.h > 40 ? r.h - 14 : 14), Math.max(1500, (dur.s4_quote - 1) * 1000));
});
// Shocks are one a minute across all visitors: wait out any cooldown first (the camera rests on the shock buttons).
await focus([['#try']], { maxScale: 1.6 });
{
  const t0 = Date.now();
  while (Date.now() - t0 < 70000 && (await page.evaluate(() => { const w = document.querySelector('#try .shock-wait'); return w && !w.hidden; }))) await sleep(500);
}
await scene('s5_setup', async () => {
  await focus([['#statusline'], ['#headline']], { maxScale: 1.6 });
  await point('#statusline', 'families alive', 800);
  await sleep(900);
  await point('#statusline', 'died', 800, 420);
  info.before = await txt('#statusline');
});
await focus([['#try']], { maxScale: 1.6 });
await scene('s5_plague', async () => {
  await point('#try', 'Hit the market', 700);
  await sleep(500);
  if (process.env.REHEARSE) await point('#try [data-shock=plague]', null, 700);
  else await click('#try [data-shock=plague]');
  await sleep(900);
  info.shockMsg = await txt('#try-msg');
  await focus([['#statusline'], ['#plot']], { maxScale: 1.1, ms: 1000 });
  const m = await rect('#muller');
  await moveTo(m.x + m.w - 80, m.y + m.h * 0.45, 1000);
});
await scene('s5_after', async () => {
  await sleep(300);
  await point('#statusline', 'died', 900, 420);
  await sleep(1800);
  const m = await rect('#muller');
  await moveTo(m.x + m.w - 80, m.y + m.h * 0.5, 1000);
  await sleep(1500);
  await point('#statusline', 'died', 800, 420);
  info.after = await txt('#statusline');
});

await scene('s6_guard', async () => {
  await focus([['#guard']], { maxScale: 1.5 });
  await point('#guard h3', null, 700);
  await sleep(500);
  await point('#guard .guard__what', 'accomplice', 800, 300);
  await sleep(1500);
  await point('#guard .guard__what', 'SIEGE', 800);
  await sleep(900);
  await point('#guard-text', 'credits stolen', 800);
  info.guard = await txt('#guard-text');
});

await scene('s7_near', async () => {
  await focus([['#proof-h'], ['#proof-contract'], ['#proof-list', 'BAD_SIGNATURE']], { maxScale: 1.4 });
  await point('#proof-contract', null, 800);
  await sleep(1500);
  await point('#proof-list', 'own key', 800);
  await sleep(2200);
  await point('#proof-list', 'BAD_SIGNATURE', 800);
  await sleep(1000);
  await point('#proof-list', 'no guard signature', 800);
});

await scene('s8_tunnel', async () => {
  await focus([['#tunnel-h'], ['#wt-q'], ['#wt-grid']], { maxScale: 1.25 });
  await point('#tunnel-h', null, 800);
  await sleep(1200);
  await point('#wt-grid', '0.48', 800);
  await sleep(500);
  await point('#wt-grid', '0.12', 600);
  await sleep(1500);
  await point('#wt-grid', '81%', 800);
  await sleep(700);
  await point('#wt-grid', '57%', 600);
  info.wt = await txt('#wt-grid');
});

await scene('s8_advice', async () => {
  await focus([['.tunnel__advice h3'], ['.tunnel__advice ol', 'A fee recycled']], { maxScale: 1.45 });
  await point('.tunnel__advice ol', 'Weight the auction', 800);
  await sleep(2600);
  await point('.tunnel__advice ol', 'A fee recycled', 800);
  await sleep(1500);
  await point('.tunnel__advice ol', '94%', 800);
});

await scene('s9_close', async () => {
  await focus([['#try'], ['.brand']], { maxScale: 1.3, spot: false, ms: 1300 });
  await point('#try [data-shock=plague]', null, 900);
  await sleep(2200);
  await focus([['#shared'], ['.foot', 'Code on GitHub']], { maxScale: 1.6, ms: 1500 });
  await point('.foot', 'Code on GitHub', 900);
});
await sleep(1500);
} catch (e) { console.error('FAILED', e); process.exitCode = 1; await page.screenshot({ path: path.join(out, 'error.png') }); }
const TEND = Date.now() / 1000;
await cdp.send('Page.stopScreencast');
await sleep(500);
info.aiLog = (await page.evaluate(() => window.__aiLog)).map((a) => ({ t: +(a.t - T0).toFixed(2), why: a.why.slice(0, 60) }));
fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames));
fs.writeFileSync(path.join(out, 'scenes.json'), JSON.stringify({ t0: T0, end: TEND - T0, scenes, info }, null, 1));
console.log('frames', frames.length, 'length', (TEND - T0).toFixed(2));
await browser.close();
