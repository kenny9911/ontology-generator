// ============================================================================
//  build-design-previews.mts — generates the claude.ai/design preview bundle
//  for the "Lumen" UI restyle proposal into docs/design/*.html.
//  Self-contained HTML cards (inline CSS, Google-font import), each with a
//  first-line @dsCard marker. Run: npx tsx scripts/build-design-previews.mts
// ============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'design');
mkdirSync(OUT, { recursive: true });

const FONTS =
  "@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap');";

/** Both palettes, exposed as CSS classes .cur (current midnight) and .lum (Lumen). */
const BASE = `
${FONTS}
* { box-sizing: border-box; margin: 0; }
body { background: #05070f; padding: 24px; font-family: "IBM Plex Sans", system-ui, sans-serif; }
.cur {
  --bg:#0a0e1a; --bg-1:#0f1426; --bg-2:#131a2e; --bg-3:#1a2238; --line:#232b45; --line-strong:#2e3a5c;
  --fg:#e7ecf5; --fg-2:#b8c1da; --fg-3:#8590ac; --fg-4:#5f6a85;
  --accent:#5b8cff; --accent-2:#a47bff; --accent-3:#6cf2d9; --warn:#ffb84d; --danger:#ff6b8b;
}
.lum {
  --bg:#0b0f1e; --bg-1:#111729; --bg-2:#161e36; --bg-3:#1e2845; --line:#28324f; --line-strong:#36436b;
  --fg:#f2f6ff; --fg-2:#ccd7f2; --fg-3:#a8b6dc; --fg-4:#8290bb;
  --accent:#7aa2ff; --accent-2:#b495ff; --accent-3:#54e8c7; --warn:#ffc266; --danger:#ff7e9c;
}
.panel {
  background:
    radial-gradient(900px 420px at 85% -10%, color-mix(in oklab, var(--accent) 9%, transparent) 0%, transparent 60%),
    var(--bg);
  border: 1px solid var(--line); border-radius: 16px; padding: 24px; color: var(--fg);
}
.lum .card, .cur .card { background: var(--bg-1); border: 1px solid var(--line); border-radius: 14px; }
.lum .card { box-shadow: inset 0 1px 0 rgba(255,255,255,0.045), 0 8px 28px rgba(0,0,0,0.35); }
.card-h { padding: 12px 16px; border-bottom: 1px solid var(--line); display:flex; align-items:center; justify-content:space-between;
  font-family:"JetBrains Mono",monospace; font-size:11px; letter-spacing:0.05em; text-transform:uppercase; color:var(--fg-3); }
.card-b { padding: 16px; }
.h-display { font-family: "Space Grotesk", sans-serif; }
.mono { font-family: "JetBrains Mono", monospace; }
.cap { font-family:"JetBrains Mono",monospace; font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--fg-3); }
.cap-old { font-family:"JetBrains Mono",monospace; font-size:10px; letter-spacing:0.06em; text-transform:uppercase; color:var(--fg-4); }
.tag { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; font-family:"JetBrains Mono",monospace; font-size:10.5px;
  letter-spacing:0.04em; text-transform:uppercase; border-radius:999px;
  background: color-mix(in oklab, var(--accent) 16%, transparent); color: var(--accent);
  border: 1px solid color-mix(in oklab, var(--accent) 34%, transparent); }
.tag.ai { background: color-mix(in oklab, var(--accent-2) 16%, transparent); color: var(--accent-2); border-color: color-mix(in oklab, var(--accent-2) 34%, transparent); }
.tag.ok { background: color-mix(in oklab, var(--accent-3) 14%, transparent); color: var(--accent-3); border-color: color-mix(in oklab, var(--accent-3) 32%, transparent); }
.tag.warn { background: color-mix(in oklab, var(--warn) 14%, transparent); color: var(--warn); border-color: color-mix(in oklab, var(--warn) 32%, transparent); }
.btn { display:inline-flex; align-items:center; gap:8px; padding:9px 16px; font-family:"IBM Plex Sans",sans-serif; font-size:13.5px; font-weight:500;
  border-radius:9px; border:1px solid var(--line-strong); background:var(--bg-2); color:var(--fg); cursor:pointer; transition: all .15s; }
.btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
.btn.ai { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color:#fff; border:none;
  box-shadow: 0 0 0 1px rgba(180,149,255,.45), 0 6px 24px rgba(122,162,255,.28); }
.btn.ghost { background: transparent; border-color: var(--line); color: var(--fg-2); }
.btn[disabled] { opacity:.4; cursor:not-allowed; }
.btn.focus { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 6px color-mix(in oklab, var(--accent) 22%, transparent); }
.lum .btn.ai { color: var(--bg); font-weight: 600; }
.ratio { font-family:"JetBrains Mono",monospace; font-size:11px; padding:2px 7px; border-radius:6px; border:1px solid var(--line); color:var(--fg-2); }
.badge-aa { color:#54e8c7; } .badge-fail { color:#ff7e9c; } .badge-aaa { color:#7aa2ff; }
h1 { font-family:"Space Grotesk",sans-serif; font-size:18px; letter-spacing:-0.01em; margin-bottom:4px; }
.sub { color: var(--fg-3); font-size: 13px; margin-bottom: 18px; }
table.spec { width:100%; border-collapse:collapse; font-size:13px; }
table.spec th { text-align:left; font-family:"JetBrains Mono",monospace; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em;
  color: var(--fg-3); padding: 8px 10px; border-bottom: 1px solid var(--line); }
table.spec td { padding: 9px 10px; border-bottom: 1px solid color-mix(in oklab, var(--line) 55%, transparent); }
`;

function page(file: string, group: string, title: string, body: string, extraCss = ''): void {
  const html = `<!-- @dsCard group="${group}" -->
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${BASE}${extraCss}</style></head>
<body>${body}</body></html>`;
  writeFileSync(path.join(OUT, file), html);
  console.log('wrote', file);
}

// ---------------------------------------------------------------------------
// 1. Colors — current vs Lumen with measured WCAG ratios
// ---------------------------------------------------------------------------
function rampRows(cls: 'cur' | 'lum'): string {
  const data = cls === 'cur'
    ? [['--fg', '#e7ecf5', '14.6:1', 'aaa', 'Primary text'], ['--fg-2', '#b8c1da', '9.6:1', 'aaa', 'Secondary'],
       ['--fg-3', '#8590ac', '5.4:1', 'aa', 'Tertiary / labels'], ['--fg-4', '#5f6a85', '3.2:1', 'fail', 'Captions / hints'],
       ['--accent', '#5b8cff', '5.5:1', 'aa', 'Links / tags / steps']]
    : [['--fg', '#f2f6ff', '15.2:1', 'aaa', 'Primary text'], ['--fg-2', '#ccd7f2', '11.4:1', 'aaa', 'Secondary'],
       ['--fg-3', '#a8b6dc', '8.2:1', 'aaa', 'Tertiary / labels'], ['--fg-4', '#8290bb', '5.2:1', 'aa', 'Captions / hints'],
       ['--accent', '#7aa2ff', '6.6:1', 'aa+', 'Links / tags / steps']];
  return data.map(([t, hex, r, b, role]) => `
    <tr><td class="mono" style="color:${hex}">${t}</td>
    <td><span style="color:${hex};font-weight:500">Aa 数据对象 — every receipt cited</span></td>
    <td class="mono" style="color:var(--fg-3)">${hex}</td>
    <td><span class="ratio">${r} <span class="badge-${b === 'fail' ? 'fail' : b === 'aaa' ? 'aaa' : 'aa'}">${b === 'fail' ? '✗ FAIL AA' : b.toUpperCase()}</span></span></td>
    <td style="color:var(--fg-3)">${role}</td></tr>`).join('');
}
page('tokens-colors.html', 'Colors', 'Lumen — color tokens & contrast', `
<div style="display:grid; gap:20px;">
  <div class="cur panel">
    <h1>Current · “Midnight”</h1>
    <div class="sub">Muted slate ramp — captions and hints sit BELOW WCAG AA on cards. Text reads dim and recessive.</div>
    <table class="spec"><tr><th>Token</th><th>Specimen on card</th><th>Hex</th><th>Contrast on card</th><th>Role</th></tr>${rampRows('cur')}</table>
  </div>
  <div class="lum panel">
    <h1>Proposed · “Lumen” <span class="tag ok" style="vertical-align:3px">every text token ≥ AA · body ≥ AAA</span></h1>
    <div class="sub">Brightened, blue-tinted luminous ramp. Same hierarchy, one full step brighter: tertiary text reaches AAA, captions clear AA, accents are vivid enough to use AS text.</div>
    <table class="spec"><tr><th>Token</th><th>Specimen on card</th><th>Hex</th><th>Contrast on card</th><th>Role</th></tr>${rampRows('lum')}</table>
    <div style="display:flex; gap:10px; margin-top:18px; flex-wrap:wrap;">
      ${[['accent', '#7aa2ff'], ['accent-2', '#b495ff'], ['accent-3', '#54e8c7'], ['warn', '#ffc266'], ['danger', '#ff7e9c']]
        .map(([n, h]) => `<div style="flex:1;min-width:120px;border:1px solid var(--line);border-radius:12px;overflow:hidden">
          <div style="height:52px;background:${h}"></div>
          <div style="padding:8px 10px"><div class="mono" style="font-size:11px;color:${h}">--${n}</div>
          <div class="mono" style="font-size:10.5px;color:var(--fg-3)">${h}</div></div></div>`).join('')}
    </div>
  </div>
</div>`);

// ---------------------------------------------------------------------------
// 2. Type
// ---------------------------------------------------------------------------
page('tokens-type.html', 'Type', 'Lumen — typography', `
<div class="lum panel">
  <h1>Type system — brighter, bigger smallest sizes</h1>
  <div class="sub">Space Grotesk display · IBM Plex Sans body · JetBrains Mono data. The smallest tier (captions) moves 10px → 11px and one color step brighter — the single biggest legibility win.</div>
  <div style="display:grid; gap:18px;">
    <div><div class="cap" style="margin-bottom:6px">display / 24 · Space Grotesk 600</div>
      <div class="h-display" style="font-size:24px;font-weight:600;letter-spacing:-0.015em">Hyper automation · 全量覆盖本体生成</div></div>
    <div><div class="cap" style="margin-bottom:6px">heading / 16 · Space Grotesk 600</div>
      <div class="h-display" style="font-size:16px;font-weight:600">Document coverage · 95.9% of coverable sentences</div></div>
    <div><div class="cap" style="margin-bottom:6px">body / 14 · Plex Sans 400 · --fg-2</div>
      <div style="font-size:14px;color:var(--fg-2);max-width:640px">Every extracted node carries verbatim citations, a computed confidence, and a review state. Uncovered sentences become remediation gaps — nothing is silently dropped.</div></div>
    <div><div class="cap" style="margin-bottom:6px">data / 13 · JetBrains Mono · tabular</div>
      <div class="mono" style="font-size:13px;color:var(--fg)">objects 20 · rules 79 · actions 33 · events 48 · coverage 0.959</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;border-top:1px solid var(--line);padding-top:16px">
      <div><div class="cap-old" style="margin-bottom:6px">before · caption 10px · --fg-4 (3.2:1 ✗)</div>
        <div class="cap-old">deep-swarm phase · business understanding</div></div>
      <div><div class="cap" style="margin-bottom:6px;color:var(--accent-3)">after · caption 11px · --fg-3 (8.2:1 ✓ AAA)</div>
        <div class="cap">deep-swarm phase · business understanding</div></div>
    </div>
  </div>
</div>`);

// ---------------------------------------------------------------------------
// 3. Buttons
// ---------------------------------------------------------------------------
page('components-buttons.html', 'Components', 'Lumen — buttons', `
<div class="lum panel">
  <h1>Buttons</h1>
  <div class="sub">Primary carries dark-on-bright text at 7.7:1. The AI action keeps its gradient identity with a soft luminous halo. Focus = ring + halo, visible on every surface.</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    <button class="btn">Secondary</button>
    <button class="btn primary">Run extraction</button>
    <button class="btn ai">✦ Hyper automation</button>
    <button class="btn ghost">Ghost</button>
    <button class="btn" disabled>Disabled</button>
    <button class="btn primary focus">Focused</button>
  </div>
  <div style="margin-top:16px" class="cap">hover: lift −1px · border brightens to accent · 150ms ease</div>
</div>`);

// ---------------------------------------------------------------------------
// 4. Tags & badges
// ---------------------------------------------------------------------------
page('components-tags.html', 'Components', 'Lumen — tags & badges', `
<div class="lum panel">
  <h1>Tags, status chips, source badges</h1>
  <div class="sub">Chip text uses the brightened accents — every variant now ≥ 6.6:1 on its tinted fill. Size bumps 10 → 10.5px.</div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
    <span class="tag">object · 12</span><span class="tag ai">✦ ai inferred</span>
    <span class="tag ok">✓ coverage met</span><span class="tag warn">! 11 findings</span>
    <span class="tag" style="background:color-mix(in oklab,var(--danger) 14%,transparent);color:var(--danger);border-color:color-mix(in oklab,var(--danger) 32%,transparent)">✗ block</span>
  </div>
  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:14px">
    <span class="ratio">router</span><span class="ratio" style="color:var(--warn)">env</span>
    <span class="ratio" style="color:var(--accent)">settings</span><span class="ratio" style="color:var(--fg-3)">default</span>
    <span class="cap">· llm source badges</span>
  </div>
</div>`);

// ---------------------------------------------------------------------------
// 5. Cards & coverage
// ---------------------------------------------------------------------------
page('components-cards.html', 'Components', 'Lumen — cards & coverage', `
<div class="lum panel" style="display:grid;grid-template-columns:1.2fr 1fr;gap:16px">
  <div class="card">
    <div class="card-h"><span>Document coverage · pass 3</span><span class="tag warn">95.9% · target 100%</span></div>
    <div class="card-b">
      <div style="height:10px;border-radius:999px;background:var(--bg-3);overflow:hidden;margin-bottom:12px">
        <div style="height:100%;width:95.9%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent-3))"></div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap" class="mono">
        <span style="color:var(--accent-3)">256 covered</span><span style="color:var(--warn)">1 partial</span>
        <span style="color:var(--danger)">10 uncovered</span><span style="color:var(--fg-3)">142 boilerplate</span>
      </div>
      <div class="cap" style="margin-top:12px">sentence-level eval · fail-closed · receipts on every verdict</div>
    </div>
  </div>
  <div class="card">
    <div class="card-h"><span>Run log</span><span class="cap" style="color:var(--accent)">live</span></div>
    <div class="card-b mono" style="font-size:12px;display:grid;gap:6px">
      <div style="color:var(--fg-2)">[hyper] phase "Gap remediation 1" — Remediate rules</div>
      <div style="color:var(--fg-2)">[swarm] deepen rules: 20 → 74 <span style="color:var(--accent-3)">(+54)</span></div>
      <div style="color:var(--fg-3)">[hyper] remediation r1: capped at 40 gap(s), 82 dropped</div>
      <div style="color:var(--warn)">rules: LLM call failed (terminated) — retrying…</div>
    </div>
  </div>
</div>`);

// ---------------------------------------------------------------------------
// 6. Forms (LLM settings)
// ---------------------------------------------------------------------------
page('components-forms.html', 'Components', 'Lumen — forms & settings rows', `
<div class="lum panel">
  <h1>LLM settings · agent row</h1>
  <div class="sub">Inputs get a visible resting border, brighter placeholder, and the accent focus halo.</div>
  <div class="card"><div class="card-b" style="display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:12px;align-items:center">
    <div><div style="font-weight:600">Rules extractor <span class="cap" style="color:var(--fg-4)">· 规则提取</span></div>
      <div style="color:var(--fg-3);font-size:12.5px">Extracts business rules and constraints (stage 2)</div></div>
    <div><div class="cap" style="margin-bottom:4px">model</div>
      <input style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--bg-2);color:var(--fg);font-family:'JetBrains Mono',monospace;font-size:12px" value="openai/gpt-5"/></div>
    <div><div class="cap" style="margin-bottom:4px">provider</div>
      <select style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line-strong);background:var(--bg-2);color:var(--fg);font-size:12.5px"><option>inherit</option><option selected>openai</option></select></div>
    <span class="ratio" style="color:var(--accent)" title="Per-agent settings override">settings</span>
  </div></div>
  <label style="display:flex;gap:10px;align-items:center;margin-top:14px;color:var(--fg-2);font-size:13.5px">
    <span style="width:34px;height:19px;border-radius:999px;background:var(--accent);position:relative;display:inline-block"><span style="position:absolute;right:2px;top:2px;width:15px;height:15px;border-radius:999px;background:var(--bg)"></span></span>
    Smart router enabled <span class="cap">picks the model per agent purpose</span></label>
</div>`);

// ---------------------------------------------------------------------------
// 7. Screen overview
// ---------------------------------------------------------------------------
page('screen-overview.html', 'Screens', 'Lumen — screen composite', `
<div class="lum panel" style="padding:0;overflow:hidden">
  <div style="display:flex;align-items:center;gap:18px;padding:12px 20px;border-bottom:1px solid var(--line);background:color-mix(in oklab,var(--bg) 88%,transparent)">
    <div class="h-display" style="font-weight:600;font-size:15px">◇ Ontology <span style="color:var(--accent)">Generator</span></div>
    <div style="display:flex;gap:4px" class="mono">
      ${['Input', 'Discover', 'Objects', 'Rules', 'Coverage'].map((s, i) => `<span style="padding:5px 11px;border-radius:7px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;${i === 1 ? 'color:var(--fg);background:color-mix(in oklab,var(--accent) 14%,transparent)' : i === 0 ? 'color:var(--accent-3)' : 'color:var(--fg-3)'}">${i + 1} ${s}</span>`).join('')}
    </div>
    <div style="margin-left:auto" class="cap" style="color:var(--fg-3)">⚙ llm settings</div>
  </div>
  <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:16px;padding:20px">
    <div class="card"><div class="card-h"><span>Hyper run · iteration 2</span><span class="tag ai">14 agents</span></div>
      <div class="card-b" style="display:grid;gap:10px">
        ${[['✓', 'Terminology & data types', '105 terms', 'ok'], ['✓', 'Business understanding', '4 SME agents', 'ok'],
           ['…', 'Document coverage eval', 'pass 2 · 0.78', 'run'], ['·', 'Final coverage gate', 'pending', 'idle']]
          .map(([m, l, d, s]) => `<div style="display:flex;gap:10px;align-items:center">
            <span class="tag ${s === 'ok' ? 'ok' : s === 'run' ? 'ai' : ''}" style="${s === 'idle' ? 'opacity:.55' : ''}">${m}</span>
            <strong style="font-size:13.5px">${l}</strong><span class="cap">· ${d}</span></div>`).join('')}
      </div></div>
    <div class="card"><div class="card-h"><span>Layers</span></div>
      <div class="card-b"><table class="spec">
        <tr><th>layer</th><th style="text-align:right">count</th><th style="text-align:right">confidence</th></tr>
        ${[['objects', 20, '0.86', 'accent'], ['rules', 79, '0.81', 'accent-2'], ['actions', 33, '0.84', 'accent'], ['events', 48, '0.78', 'accent-3']]
          .map(([l, c, conf, col]) => `<tr><td style="color:var(--${col})" class="mono">${l}</td>
          <td class="mono" style="text-align:right">${c}</td><td class="mono" style="text-align:right;color:var(--fg-2)">${conf}</td></tr>`).join('')}
      </table></div></div>
  </div>
</div>`);

// ---------------------------------------------------------------------------
// 8. Review findings
// ---------------------------------------------------------------------------
page('review-findings.html', 'Review', 'UI style review — findings & direction', `
<div class="lum panel">
  <h1>UI style review — findings → “Lumen” direction</h1>
  <div class="sub">Audit of the current Midnight theme (measured WCAG ratios on card surfaces) and the proposed direction.</div>
  <table class="spec">
    <tr><th>#</th><th>Finding</th><th>Measured</th><th>Lumen move</th></tr>
    <tr><td>1</td><td>Caption/hint text (--fg-4) fails WCAG AA — used by every label, hint, step, and log line</td>
      <td class="mono badge-fail">3.2:1</td><td>Brightened ramp → <span class="mono badge-aa">5.2:1 AA</span>; captions also move up a color step + 10→11px</td></tr>
    <tr><td>2</td><td>Tertiary text (--fg-3) misses AAA; UI feels uniformly dim</td>
      <td class="mono">5.4:1</td><td><span class="mono badge-aaa">8.2:1 AAA</span> — hierarchy preserved, one step brighter across the ramp</td></tr>
    <tr><td>3</td><td>Accents double as text (tags, links, steps) at borderline ratios</td>
      <td class="mono">5.5:1</td><td>OKLCH-brightened accents: all five ≥ <span class="mono badge-aa">6.6:1</span> as text, still saturated as fills</td></tr>
    <tr><td>4</td><td>Flat single-tone surfaces — cards barely separate from the page</td>
      <td class="mono">Δlum ~2%</td><td>Deeper page, +1 elevation step, inner top highlight + soft shadow on cards (modern depth without borders shouting)</td></tr>
    <tr><td>5</td><td>Focus states are a thin outline only</td><td class="mono">2px ring</td>
      <td>Ring + 6px luminous halo — visible on any surface, keyboard-first</td></tr>
  </table>
  <div class="cap" style="margin-top:16px">principles: receipts-grade legibility · luminous not loud · hierarchy by brightness, identity by hue</div>
</div>`);

console.log('done →', OUT);
