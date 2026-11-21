#!/usr/bin/env node
/**
 * Dev-only: render default gift_tree theme images via headless Edge + CDP.
 * Usage:  node scripts/export-default-theme.mjs [--force]
 *
 * Requires: Microsoft Edge at the standard macOS path.
 * Uses Node 22 built-in WebSocket + fetch — no new npm dependencies.
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = join(__dirname, '..')
const OUT_DIR   = join(ROOT, 'public', 'theme', 'gift_tree', 'default')
const EDGE      = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const PORT      = 9227
const FORCE     = process.argv.includes('--force')

const FILES = [
  'sky_portrait.webp', 'sky_landscape.webp', 'layer_ground.webp',
  'tree.webp', 'star.webp',
  ...Array.from({length:6},(_,i)=>`ornament_${i+1}.webp`),
  ...Array.from({length:6},(_,i)=>`box_${i+1}_closed.webp`),
]

if (!FORCE) {
  const existing = FILES.filter(f => existsSync(join(OUT_DIR, f)))
  if (existing.length) {
    console.error('Error: files already exist — use --force to overwrite:\n  ' + existing.join('\n  '))
    process.exit(1)
  }
}

mkdirSync(OUT_DIR, { recursive: true })

// ─── CDP helpers ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForCDP(port, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/json/list`)
      if (res.ok) return await res.json()
    } catch { /* not ready yet */ }
    await sleep(200)
  }
  throw new Error('CDP not ready after ' + timeout + ' ms')
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 1

    ws.addEventListener('error', e => reject(new Error('WebSocket error: ' + e.message)))
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id == null) return
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    })

    ws.addEventListener('open', () => {
      resolve({
        call(method, params = {}) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        close() { ws.close() },
      })
    })
  })
}

// ─── Browser-side drawing code (runs inside headless Edge) ──────────────────

const DRAWING_CODE = /* javascript */ `
(async function drawAll() {
  'use strict';

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
  }
  function webp(c) {
    return c.toDataURL('image/webp', 0.9).replace('data:image/webp;base64,', '');
  }
  function mkRng(seed) {
    let s = seed | 0;
    return () => ((s = (s * 1664525 + 1013904223) | 0) >>> 0) / 4294967296;
  }

  // ── Shared drawing primitives ──────────────────────────────────────────────

  function star5path(ctx, cx, cy, outer, inner) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI / 5) - Math.PI / 2;
      const r = i % 2 === 0 ? outer : inner;
      i === 0 ? ctx.moveTo(cx + Math.cos(a)*r, cy + Math.sin(a)*r)
              : ctx.lineTo(cx + Math.cos(a)*r, cy + Math.sin(a)*r);
    }
    ctx.closePath();
  }

  // ── SKY backdrop ──────────────────────────────────────────────────────────

  function skyGrad(ctx, W, H) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0,    '#060d1f');
    g.addColorStop(0.50, '#0d1b4b');
    g.addColorStop(0.75, '#1a2a6c');
    g.addColorStop(0.90, '#d4eaf5');
    g.addColorStop(1,    '#a8d4e8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawAurora(ctx, W, H) {
    const g = ctx.createLinearGradient(0, H*0.06, 0, H*0.42);
    g.addColorStop(0,    'rgba(0,255,140,0)');
    g.addColorStop(0.35, 'rgba(0,255,140,0.07)');
    g.addColorStop(0.65, 'rgba(0,140,255,0.09)');
    g.addColorStop(1,    'rgba(0,140,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H*0.06, W, H*0.36);
  }

  function drawMoon(ctx, cx, cy, r) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,220,80,0.3)';
    ctx.shadowBlur  = r * 1.5;
    const g = ctx.createRadialGradient(cx - r*0.3, cy - r*0.3, r*0.08, cx, cy, r);
    g.addColorStop(0,    '#fffde7');
    g.addColorStop(0.65, '#ffd54f');
    g.addColorStop(1,    '#ff9800');
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
  }

  function drawStars(ctx, W, H, maxY, count, seed) {
    const rng = mkRng(seed);
    for (let i = 0; i < count; i++) {
      const x = rng() * W, y = rng() * H * maxY;
      const r = 0.5 + rng() * 1.5, a = 0.3 + rng() * 0.7;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
      ctx.fillStyle = \`rgba(255,255,255,\${a.toFixed(2)})\`;
      ctx.fill();
    }
  }

  function drawHillsOnSky(ctx, W, H, hillTop) {
    // back hill — bluish
    ctx.beginPath();
    ctx.moveTo(-10, hillTop + H*0.07);
    ctx.bezierCurveTo(W*0.15, hillTop - H*0.04, W*0.4, hillTop + H*0.06, W*0.6, hillTop - H*0.015);
    ctx.bezierCurveTo(W*0.8, hillTop - H*0.07, W*0.9, hillTop + H*0.025, W+10, hillTop - H*0.045);
    ctx.lineTo(W+10, H); ctx.lineTo(-10, H); ctx.closePath();
    ctx.fillStyle = 'rgba(230,242,255,0.95)'; ctx.fill();
    // front hill — white
    ctx.beginPath();
    ctx.moveTo(-10, hillTop + H*0.14);
    ctx.bezierCurveTo(W*0.2, hillTop + H*0.05, W*0.45, hillTop + H*0.11, W*0.65, hillTop + H*0.06);
    ctx.bezierCurveTo(W*0.85, hillTop + H*0.01, W*0.95, hillTop + H*0.055, W+10, hillTop + H*0.02);
    ctx.lineTo(W+10, H); ctx.lineTo(-10, H); ctx.closePath();
    ctx.fillStyle = 'white'; ctx.fill();
  }

  // ── SKY PORTRAIT 1080×1920 ─────────────────────────────────────────────────
  function makeSkyPortrait() {
    const [c,ctx] = mk(1080, 1920);
    skyGrad(ctx, 1080, 1920);
    drawAurora(ctx, 1080, 1920);
    drawStars(ctx, 1080, 1920, 0.72, 160, 1);
    drawMoon(ctx, 850, 240, 72);
    drawHillsOnSky(ctx, 1080, 1920, 1620);
    return webp(c);
  }

  // ── SKY LANDSCAPE 1920×1080 ────────────────────────────────────────────────
  function makeSkyLandscape() {
    const [c,ctx] = mk(1920, 1080);
    skyGrad(ctx, 1920, 1080);
    drawAurora(ctx, 1920, 1080);
    drawStars(ctx, 1920, 1080, 0.70, 180, 2);
    drawMoon(ctx, 1680, 180, 72);
    drawHillsOnSky(ctx, 1920, 1080, 870);
    return webp(c);
  }

  // ── LAYER GROUND 1920×500 (transparent) ────────────────────────────────────
  function makeLayerGround() {
    const [c,ctx] = mk(1920, 500);
    // transparent canvas — draw only the hills
    // back hill
    ctx.beginPath();
    ctx.moveTo(-10, 310);
    ctx.bezierCurveTo(240, 95,  640, 215,  960, 160);
    ctx.bezierCurveTo(1280, 105, 1600, 240, 1930, 115);
    ctx.lineTo(1930, 500); ctx.lineTo(-10, 500); ctx.closePath();
    ctx.fillStyle = 'rgba(220,238,255,0.95)'; ctx.fill();
    // front hill
    ctx.beginPath();
    ctx.moveTo(-10, 365);
    ctx.bezierCurveTo(320, 240, 720, 318, 1040, 265);
    ctx.bezierCurveTo(1360, 212, 1680, 298, 1930, 238);
    ctx.lineTo(1930, 500); ctx.lineTo(-10, 500); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.97)'; ctx.fill();
    // small tree silhouettes left
    [[30,230],[55,250],[80,230]].forEach(([x,y]) => {
      ctx.fillStyle='rgba(40,80,120,0.5)';
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x-18,y+40); ctx.lineTo(x+18,y+40); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x,y+15); ctx.lineTo(x-24,y+55); ctx.lineTo(x+24,y+55); ctx.closePath(); ctx.fill();
    });
    // right side
    [[1850,205],[1875,225],[1900,205]].forEach(([x,y]) => {
      ctx.fillStyle='rgba(40,80,120,0.45)';
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x-16,y+36); ctx.lineTo(x+16,y+36); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x,y+13); ctx.lineTo(x-21,y+50); ctx.lineTo(x+21,y+50); ctx.closePath(); ctx.fill();
    });
    return webp(c);
  }

  // ── TREE 1200×1600 (transparent) ───────────────────────────────────────────
  // tip (600,90), foliage base y=1310, half-width=520 at base
  // Scales from mockup 320×560 viewBox (star at y=36, tier-4 base at y=408)
  const TX = x => (x - 160) * (520/140) + 600;
  const TY = y => y * (1220/372) - 28.07;
  const TDY = d => d * (1220/372);  // scale tip-depth in y

  const TIERS = [
    [160, 50,  128, 192, 150,  5, 11],
    [160, 112,  92, 228, 232,  8, 14],
    [160, 180,  56, 264, 318, 11, 16],
    [160, 248,  20, 300, 408, 15, 18],
  ];
  const TIER_COLS = [
    ['#3a7d55','#52b788','#1b4332'],
    ['#2d6a4f','#40916c','#1a3c2d'],
    ['#266045','#38815e','#163528'],
    ['#1f5238','#2d6a4f','#122a1e'],
  ];

  function jaggedPath(ctx, ax, ay, bl, br, by, nt, td) {
    const step = (br - bl) / nt;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bl, by);
    for (let i = 0; i < nt; i++) {
      ctx.lineTo(bl + step*(i+0.5), by + td);
      if (i < nt-1) ctx.lineTo(bl + step*(i+1), by);
    }
    ctx.lineTo(br, by);
    ctx.closePath();
  }

  function makeTree() {
    const [c,ctx] = mk(1200, 1600);

    // drop shadow layer
    ctx.save();
    ctx.shadowColor='rgba(5,16,10,0.5)'; ctx.shadowBlur=24; ctx.shadowOffsetX=10; ctx.shadowOffsetY=24;
    TIERS.forEach(([ax,ay,bl,br,by,nt,td],i) => {
      const sax=TX(ax),say=TY(ay),sbl=TX(bl),sbr=TX(br),sby=TY(by),std=TDY(td);
      const [c0,c1,c2]=TIER_COLS[i];
      const g=ctx.createLinearGradient(sax,say,sbr,sby);
      g.addColorStop(0,c0); g.addColorStop(0.4,c1); g.addColorStop(1,c2);
      ctx.beginPath(); jaggedPath(ctx,sax,say,sbl,sbr,sby,nt,std);
      ctx.fillStyle=g; ctx.fill();
    });
    ctx.restore();

    // side-shadow overlay
    TIERS.forEach(([ax,ay,bl,br,by,nt,td]) => {
      const sax=TX(ax),say=TY(ay),sbl=TX(bl),sbr=TX(br),sby=TY(by),std=TDY(td);
      const sg=ctx.createLinearGradient(sbl,0,sbr,0);
      sg.addColorStop(0,'rgba(0,0,0,0.25)'); sg.addColorStop(0.35,'rgba(0,0,0,0)'); sg.addColorStop(1,'rgba(0,0,0,0.3)');
      ctx.beginPath(); jaggedPath(ctx,sax,say,sbl,sbr,sby,nt,std);
      ctx.fillStyle=sg; ctx.fill();
    });

    // needle texture (subtle cross-hatch)
    ctx.save();
    ctx.globalAlpha=0.07;
    TIERS.forEach(([ax,ay,bl,br,by,nt,td]) => {
      const sbl=TX(bl),sbr=TX(br),sby=TY(by),std=TDY(td),step=(sbr-sbl)/nt;
      for(let i=0;i<nt;i++){
        const tx=sbl+step*(i+0.5), ty=sby+std;
        ctx.strokeStyle='rgba(255,255,255,1)'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(tx-7,ty+9); ctx.lineTo(tx,ty); ctx.lineTo(tx+7,ty+9); ctx.stroke();
      }
    });
    ctx.restore();

    // garland beads
    const beadCols=['#fbbf24','#e5e7eb','#f9a8d4','#fbbf24'];
    TIERS.forEach(([,,bl,br,by,nt],ti) => {
      const sbl=TX(bl),sbr=TX(br),sby=TY(by),mid=(sbl+sbr)/2;
      const nBeads=ti+5;
      for(let j=0;j<=nBeads;j++){
        const t=j/nBeads;
        const qx=(1-t)*(1-t)*sbl+2*(1-t)*t*mid+t*t*sbr;
        const qy=sby+18;
        ctx.beginPath(); ctx.arc(qx,qy,5,0,Math.PI*2);
        ctx.fillStyle=beadCols[(ti*7+j)%beadCols.length]; ctx.fill();
      }
    });

    // Christmas lights
    const lightCols=['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff6bbf','#fff'];
    TIERS.forEach(([,,bl,br,by,nt,td],ti) => {
      const sbl=TX(bl),sbr=TX(br),sby=TY(by),std=TDY(td),step=(sbr-sbl)/nt;
      for(let j=0;j<nt;j++){
        const lx=sbl+step*(j+0.5), ly=sby+std;
        const col=lightCols[(ti*nt+j)%lightCols.length];
        ctx.save(); ctx.shadowColor=col; ctx.shadowBlur=14;
        ctx.beginPath(); ctx.arc(lx,ly,7,0,Math.PI*2);
        ctx.fillStyle=col; ctx.fill(); ctx.restore();
      }
    });

    // trunk
    const tw=92, ty0=TY(408);
    ctx.fillStyle='#7c4a1e';
    ctx.beginPath(); ctx.roundRect(600-tw/2,ty0,tw,(44/560)*1600*0.78,6); ctx.fill();
    ctx.fillStyle='#5c3410';
    ctx.beginPath(); ctx.roundRect(600-72,ty0+(44/560)*1600*0.78-18,144,26,8); ctx.fill();

    // tree skirt
    const skirtY=TY(458), skirtRX=460, skirtRY=36;
    ctx.beginPath(); ctx.ellipse(600,skirtY,skirtRX,skirtRY,0,0,Math.PI*2);
    ctx.fillStyle='#c41e3a'; ctx.fill();
    ctx.save(); ctx.setLineDash([12,8]);
    ctx.strokeStyle='#ffd700'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.ellipse(600,skirtY,skirtRX,skirtRY,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();

    return webp(c);
  }

  // ── STAR 256×256 (transparent, centre at 128,128) ──────────────────────────
  function makeStar() {
    const [c,ctx] = mk(256, 256);
    const cx=128, cy=128;
    // outer glow
    ctx.save();
    ctx.shadowColor='rgba(255,215,0,0.7)'; ctx.shadowBlur=32;
    star5path(ctx,cx,cy,96,42);
    ctx.fillStyle='#FFE033'; ctx.fill();
    ctx.restore();
    // stroke
    star5path(ctx,cx,cy,96,42);
    ctx.strokeStyle='#FFD700'; ctx.lineWidth=1.5; ctx.stroke();
    // shimmer overlay
    star5path(ctx,cx,cy,96,42);
    ctx.fillStyle='rgba(255,255,255,0.18)'; ctx.fill();
    // specular
    ctx.save();
    const hg=ctx.createRadialGradient(cx-28,cy-30,4,cx-18,cy-22,58);
    hg.addColorStop(0,'rgba(255,255,255,0.52)'); hg.addColorStop(1,'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.ellipse(cx-24,cy-28,48,62,-0.4,0,Math.PI*2);
    ctx.fillStyle=hg; ctx.fill();
    ctx.restore();
    // white centre
    ctx.beginPath(); ctx.arc(cx,cy,10,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.fill();
    // rays
    for(let i=0;i<5;i++){
      const a=(i*72-90)*Math.PI/180;
      ctx.save(); ctx.strokeStyle='#FFD700'; ctx.lineWidth=4; ctx.lineCap='round';
      ctx.shadowColor='#FFD700'; ctx.shadowBlur=10;
      ctx.beginPath();
      ctx.moveTo(cx+Math.cos(a)*100, cy+Math.sin(a)*100);
      ctx.lineTo(cx+Math.cos(a)*116, cy+Math.sin(a)*116);
      ctx.stroke(); ctx.restore();
    }
    return webp(c);
  }

  // ── ORNAMENTS 256×256 (transparent, hanging point top-centre 128,16) ────────
  function drawBauble(ctx, cx, cy, r, color) {
    // wire
    ctx.save(); ctx.strokeStyle='rgba(130,130,130,0.8)'; ctx.lineWidth=2.5; ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(cx,16); ctx.lineTo(cx,cy-r-10); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    // cap
    ctx.fillStyle='#c8a200';
    ctx.beginPath(); ctx.roundRect(cx-14,cy-r-10,28,18,4); ctx.fill();
    ctx.strokeStyle='#c8a200'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.ellipse(cx,cy-r-1,10,12,0,0,Math.PI*2); ctx.stroke();
    // body
    ctx.save();
    ctx.shadowColor='rgba(0,0,0,0.4)'; ctx.shadowBlur=20; ctx.shadowOffsetY=10;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fillStyle=color; ctx.fill();
    ctx.restore();
    // radial highlight
    const hg=ctx.createRadialGradient(cx-r*0.35,cy-r*0.3,r*0.07,cx,cy,r);
    hg.addColorStop(0,'rgba(255,255,255,0.72)'); hg.addColorStop(0.45,'rgba(255,255,255,0)'); hg.addColorStop(1,'rgba(0,0,0,0.3)');
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=hg; ctx.fill();
    // specular
    ctx.beginPath(); ctx.ellipse(cx-r*0.3,cy-r*0.2,r*0.26,r*0.37,-0.5,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.fill();
  }

  function drawBell(ctx, cx, cy, r, color) {
    ctx.strokeStyle='rgba(130,130,130,0.7)'; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.moveTo(cx,16); ctx.lineTo(cx,cy-r-6); ctx.stroke();
    ctx.fillStyle='#c8a200';
    ctx.beginPath(); ctx.roundRect(cx-11,cy-r-6,22,20,4); ctx.fill();
    const bt=cy-r+10, bh=r*1.95;
    const bg=ctx.createRadialGradient(cx-r*0.3,bt+bh*0.3,r*0.1,cx,bt+bh*0.5,r);
    bg.addColorStop(0,'rgba(255,255,255,0.45)'); bg.addColorStop(1,'rgba(0,0,0,0.2)');
    ctx.save(); ctx.shadowColor='rgba(0,0,0,0.3)'; ctx.shadowBlur=15;
    ctx.beginPath();
    ctx.moveTo(cx,bt);
    ctx.bezierCurveTo(cx-r,bt,cx-r*1.12,bt+bh*0.65,cx-r*1.12,bt+bh*0.82);
    ctx.lineTo(cx-r*1.12,bt+bh); ctx.lineTo(cx+r*1.12,bt+bh); ctx.lineTo(cx+r*1.12,bt+bh*0.82);
    ctx.bezierCurveTo(cx+r*1.12,bt+bh*0.65,cx+r,bt,cx,bt);
    ctx.closePath();
    ctx.fillStyle=color; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx,bt);
    ctx.bezierCurveTo(cx-r,bt,cx-r*1.12,bt+bh*0.65,cx-r*1.12,bt+bh*0.82);
    ctx.lineTo(cx-r*1.12,bt+bh); ctx.lineTo(cx+r*1.12,bt+bh); ctx.lineTo(cx+r*1.12,bt+bh*0.82);
    ctx.bezierCurveTo(cx+r*1.12,bt+bh*0.65,cx+r,bt,cx,bt);
    ctx.closePath();
    ctx.fillStyle=bg; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.ellipse(cx,bt+bh,r*1.12,r*0.3,0,0,Math.PI*2);
    ctx.fillStyle=color; ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx,bt+bh-5,r*1.12,r*0.3,0,Math.PI,0);
    ctx.fillStyle='rgba(0,0,0,0.14)'; ctx.fill();
    ctx.fillStyle='#c8a200';
    ctx.beginPath(); ctx.arc(cx,bt+bh+14,9,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f0c600';
    ctx.beginPath(); ctx.arc(cx,bt+bh+12,7,0,Math.PI*2); ctx.fill();
  }

  function drawCandyCane(ctx, cx, color) {
    // J-shape: hook at top (cx, 16), straight stick going down
    const hcy=50, hcx=cx+22, stickBot=190;
    // drop shadow
    ctx.save(); ctx.shadowColor='rgba(0,0,0,0.25)'; ctx.shadowBlur=10; ctx.shadowOffsetX=4; ctx.shadowOffsetY=6;
    ctx.strokeStyle='white'; ctx.lineWidth=26; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(cx,stickBot); ctx.lineTo(cx,hcy); ctx.arc(hcx,hcy,22,Math.PI,0,true); ctx.stroke();
    ctx.restore();
    // stripe via pattern
    const pc=document.createElement('canvas'); pc.width=20; pc.height=20;
    const px=pc.getContext('2d');
    px.fillStyle=color; px.fillRect(0,0,10,20);
    px.fillStyle='white'; px.fillRect(10,0,10,20);
    const pat=ctx.createPattern(pc,'repeat');
    ctx.save();
    ctx.translate(cx-cx,0); // keep origin
    ctx.strokeStyle=pat; ctx.lineWidth=22; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(cx,stickBot); ctx.lineTo(cx,hcy); ctx.arc(hcx,hcy,22,Math.PI,0,true); ctx.stroke();
    ctx.restore();
    // specular
    ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=5; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(cx-5,stickBot-4); ctx.lineTo(cx-5,hcy+4); ctx.arc(hcx,hcy,18,Math.PI+0.35,Math.PI-0.1,true); ctx.stroke();
  }

  function drawSnowflake(ctx, cx, cy, r, color) {
    ctx.save();
    // wire
    ctx.strokeStyle='rgba(130,130,130,0.7)'; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.moveTo(cx,16); ctx.lineTo(cx,cy-r-8); ctx.stroke();
    // small cap
    ctx.fillStyle='rgba(180,220,255,0.7)';
    ctx.beginPath(); ctx.arc(cx,cy-r-8,6,0,Math.PI*2); ctx.fill();
    // 6 arms
    ctx.strokeStyle=color; ctx.lineWidth=4.5; ctx.lineCap='round';
    for(let i=0;i<6;i++){
      const a=i*60*Math.PI/180;
      const ex=cx+Math.cos(a)*r, ey=cy+Math.sin(a)*r;
      ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(ex,ey); ctx.stroke();
      // inner branches
      const mx=cx+Math.cos(a)*r*0.52, my=cy+Math.sin(a)*r*0.52;
      const ba1=(i*60+60)*Math.PI/180, ba2=(i*60-60)*Math.PI/180;
      ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(mx+Math.cos(ba1)*r*0.3,my+Math.sin(ba1)*r*0.3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx,my); ctx.lineTo(mx+Math.cos(ba2)*r*0.3,my+Math.sin(ba2)*r*0.3); ctx.stroke();
      // outer branches
      const ox=cx+Math.cos(a)*r*0.75, oy=cy+Math.sin(a)*r*0.75;
      ctx.lineWidth=2.5;
      ctx.beginPath(); ctx.moveTo(ox,oy); ctx.lineTo(ox+Math.cos(ba1)*r*0.2,oy+Math.sin(ba1)*r*0.2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ox,oy); ctx.lineTo(ox+Math.cos(ba2)*r*0.2,oy+Math.sin(ba2)*r*0.2); ctx.stroke();
      ctx.lineWidth=4.5;
    }
    ctx.beginPath(); ctx.arc(cx,cy,10,0,Math.PI*2);
    ctx.fillStyle=color; ctx.fill();
    ctx.beginPath(); ctx.arc(cx,cy,6,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.fill();
    ctx.restore();
  }

  function makeOrnament(n) {
    const [c,ctx] = mk(256, 256);
    const cx=128;
    switch(n) {
      case 1: drawBauble(ctx, cx, 155, 86, '#e63946'); break;         // red bauble
      case 2: drawBauble(ctx, cx, 155, 86, '#4fc3f7'); break;         // blue bauble
      case 3: // gold star ornament
        ctx.strokeStyle='rgba(130,130,130,0.8)'; ctx.lineWidth=2.5; ctx.setLineDash([5,4]);
        ctx.beginPath(); ctx.moveTo(cx,16); ctx.lineTo(cx,52); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle='#c8a200'; ctx.beginPath(); ctx.roundRect(cx-13,52,26,16,4); ctx.fill();
        ctx.save(); ctx.shadowColor='rgba(255,215,0,0.55)'; ctx.shadowBlur=22;
        star5path(ctx,cx,152,82,36); ctx.fillStyle='#FFE033'; ctx.fill(); ctx.restore();
        star5path(ctx,cx,152,82,36); ctx.strokeStyle='#FFD700'; ctx.lineWidth=1.5; ctx.stroke();
        star5path(ctx,cx,152,82,36); ctx.fillStyle='rgba(255,255,255,0.18)'; ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx-22,128,26,36,-0.4,0,Math.PI*2);
        ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.fill();
        break;
      case 4: drawBell(ctx, cx, 90, 56, '#ffd700'); break;            // gold bell
      case 5: drawCandyCane(ctx, cx, '#e63946'); break;               // red/white candy cane
      case 6: drawSnowflake(ctx, cx, 150, 74, '#7dd3fc'); break;      // blue snowflake
    }
    return webp(c);
  }

  // ── BOXES 512×512 (transparent, bottom-centre 256,500) ─────────────────────
  function adjColor(hex, amt) {
    const n=parseInt(hex.replace('#',''),16);
    const cl=v=>Math.max(0,Math.min(255,v));
    const r=cl((n>>16)+amt), g=cl(((n>>8)&0xff)+amt), b=cl((n&0xff)+amt);
    return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
  }

  const BOX_CFGS = [
    {bc:'#c0392b', rc:'#ffd700', pat:'solid'},
    {bc:'#2d6a4f', rc:'#ffffff', pat:'stripe'},
    {bc:'#1e3a8a', rc:'#f9a8d4', pat:'dot'},
    {bc:'#7c3aed', rc:'#fbbf24', pat:'plaid'},
    {bc:'#d97706', rc:'#7dd3fc', pat:'stars'},
    {bc:'#be185d', rc:'#ffd700', pat:'solid'},
  ];

  function makeBox(n) {
    const [c,ctx] = mk(512, 512);
    const {bc, rc, pat} = BOX_CFGS[n-1];
    const BW=380, BH=240, LH=58, BX=(512-380)/2, BBot=500, BTop=BBot-BH, LTop=BTop-LH;

    // contact shadow
    ctx.save(); ctx.shadowColor='rgba(0,0,0,0.28)'; ctx.shadowBlur=22; ctx.shadowOffsetY=10;
    ctx.beginPath(); ctx.ellipse(256,BBot+6,BW*0.46,16,0,0,Math.PI*2);
    ctx.fillStyle='rgba(0,0,0,0.001)'; ctx.fill(); ctx.restore();

    // body fill
    ctx.fillStyle=bc;
    ctx.beginPath(); ctx.roundRect(BX,BTop,BW,BH,5); ctx.fill();

    // pattern on body
    ctx.save(); ctx.beginPath(); ctx.roundRect(BX,BTop,BW,BH,5); ctx.clip();
    if(pat==='stripe'){
      ctx.strokeStyle=rc; ctx.lineWidth=15; ctx.globalAlpha=0.4;
      for(let x=BX-BH;x<BX+BW+BH;x+=30){
        ctx.beginPath(); ctx.moveTo(x,BTop); ctx.lineTo(x+BH,BBot); ctx.stroke();
      }
    } else if(pat==='dot'){
      ctx.fillStyle=rc; ctx.globalAlpha=0.4;
      for(let dx=BX+45;dx<BX+BW-15;dx+=72){
        for(let dy=BTop+50;dy<BBot-15;dy+=72){
          ctx.beginPath(); ctx.arc(dx,dy,13,0,Math.PI*2); ctx.fill();
        }
      }
    } else if(pat==='plaid'){
      ctx.strokeStyle=rc; ctx.lineWidth=10; ctx.globalAlpha=0.28;
      for(let i=1;i<3;i++){
        ctx.beginPath(); ctx.moveTo(BX+BW*i/3,BTop); ctx.lineTo(BX+BW*i/3,BBot); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(BX,BTop+BH*i/3); ctx.lineTo(BX+BW,BTop+BH*i/3); ctx.stroke();
      }
    } else if(pat==='stars'){
      ctx.globalAlpha=0.4;
      [[0.25,0.38],[0.65,0.52],[0.45,0.7]].forEach(([px,py])=>{
        star5path(ctx, BX+BW*px, BTop+BH*py, 22, 10);
        ctx.fillStyle=rc; ctx.fill();
      });
    }
    ctx.restore();

    // lid
    ctx.fillStyle=adjColor(bc,-14);
    ctx.beginPath(); ctx.roundRect(BX-6,LTop,BW+12,LH,5); ctx.fill();

    // vertical ribbon
    const ribW=Math.round(BW*0.14);
    ctx.save(); ctx.globalAlpha=0.88; ctx.fillStyle=rc;
    ctx.fillRect(256-ribW/2,BTop,ribW,BH); ctx.restore();
    // horizontal ribbon on lid
    ctx.save(); ctx.globalAlpha=0.55; ctx.fillStyle=rc;
    ctx.fillRect(BX-6,LTop,BW+12,LH); ctx.restore();

    // bow
    const bx=256, by=LTop, lw=BW*0.09, lh=LH*0.5;
    ctx.save(); ctx.globalAlpha=0.92; ctx.fillStyle=rc;
    ctx.beginPath(); ctx.ellipse(bx-lw,by,lw*0.95,lh*0.8,-0.5,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(bx+lw,by,lw*0.95,lh*0.8,0.5,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(bx,by,lw*0.38,0,Math.PI*2);
    ctx.fillStyle=adjColor(rc,-22); ctx.fill();
    ctx.save(); ctx.strokeStyle=rc; ctx.lineWidth=lw*0.32; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(bx,by); ctx.quadraticCurveTo(bx-lw*1.4,by+lh*1.8,bx-lw*1.1,by+lh*2.9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx,by); ctx.quadraticCurveTo(bx+lw*1.4,by+lh*1.8,bx+lw*1.1,by+lh*2.9); ctx.stroke();
    ctx.restore();

    // shine
    ctx.fillStyle='rgba(255,255,255,0.1)';
    ctx.fillRect(BX+BW*0.1, BTop+BH*0.08, BW*0.07, BH*0.22);

    return webp(c);
  }

  // ── Collect all results ────────────────────────────────────────────────────
  const out = {
    sky_portrait:  makeSkyPortrait(),
    sky_landscape: makeSkyLandscape(),
    layer_ground:  makeLayerGround(),
    tree:          makeTree(),
    star:          makeStar(),
  };
  for(let i=1;i<=6;i++) out['ornament_'+i] = makeOrnament(i);
  for(let i=1;i<=6;i++) out['box_'+i+'_closed'] = makeBox(i);

  return out;
})()
`

// ─── Main ────────────────────────────────────────────────────────────────────

let edgeProc = null

async function main() {
  // Launch Edge headless
  edgeProc = spawn(EDGE, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ], { stdio: 'ignore' })

  edgeProc.on('error', e => { console.error('Edge failed to start:', e.message); process.exit(1) })

  console.log('⏳  Waiting for headless Edge...')
  const tabs = await waitForCDP(PORT)
  if (!tabs.length) throw new Error('No CDP tabs')

  const wsUrl = tabs[0].webSocketDebuggerUrl
  if (!wsUrl) throw new Error('No webSocketDebuggerUrl')

  const cdp = await cdpConnect(wsUrl)
  await cdp.call('Runtime.enable')

  console.log('🎨  Drawing all canvases...')
  const result = await cdp.call('Runtime.evaluate', {
    expression:    DRAWING_CODE,
    returnByValue: true,
    awaitPromise:  true,
    timeout:       60000,
  })

  if (result.exceptionDetails) {
    throw new Error('Drawing failed: ' + JSON.stringify(result.exceptionDetails))
  }

  const data = result.result.value
  if (!data || typeof data !== 'object') throw new Error('Unexpected result type')

  // Write files
  const slotMap = {
    sky_portrait:   'sky_portrait.webp',
    sky_landscape:  'sky_landscape.webp',
    layer_ground:   'layer_ground.webp',
    tree:           'tree.webp',
    star:           'star.webp',
  }
  for (let i = 1; i <= 6; i++) {
    slotMap[`ornament_${i}`]    = `ornament_${i}.webp`
    slotMap[`box_${i}_closed`]  = `box_${i}_closed.webp`
  }

  let totalBytes = 0
  for (const [key, filename] of Object.entries(slotMap)) {
    const b64 = data[key]
    if (typeof b64 !== 'string' || !b64) throw new Error(`Missing data for ${key}`)
    const buf = Buffer.from(b64, 'base64')
    writeFileSync(join(OUT_DIR, filename), buf)
    totalBytes += buf.length
    console.log(`  ✓ ${filename.padEnd(26)} ${(buf.length / 1024).toFixed(1)} KB`)
  }

  console.log(`\n  Total: ${(totalBytes / 1024).toFixed(1)} KB  (limit 3072 KB)`)
  if (totalBytes > 3 * 1024 * 1024) console.warn('⚠️  Total exceeds 3 MB!')

  cdp.close()
  edgeProc.kill()
  console.log('✅  Done →', OUT_DIR)
}

main().catch(e => {
  console.error('Fatal:', e.message)
  if (edgeProc) edgeProc.kill()
  process.exit(1)
})
