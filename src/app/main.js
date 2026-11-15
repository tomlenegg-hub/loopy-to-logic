import sqlWasm from 'sql.js/dist/sql-wasm.wasm?url';
import { analyse, runExport, zipFiles, manifestFor, NeedsChoiceError, SameFileError, clearCache } from './engine.js';
import { renderMarkdown } from './markdown.js';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

const $ = (id) => document.getElementById(id);
const sqlOptions = { locateFile: () => sqlWasm };
let analysis = null;
let files = [];
let busy = false;
const roots = { project: undefined, baseline: undefined }; // chosen project folder when a zip holds several

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const setStatus = (msg, error = false) => { const s = $('status'); s.textContent = msg; s.classList.toggle('error', error); };

function offerChoice(err) {
  const box = $('choose');
  box.hidden = false;
  box.innerHTML = '';
  const h = document.createElement('p');
  h.textContent = err.message;
  box.append(h);
  err.candidates.forEach((c) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: `${c.name}${c.prefix ? `  (${c.prefix})` : ''}` });
    b.onclick = () => { roots[err.role === 'Project' ? 'project' : 'baseline'] = c.prefix; box.hidden = true; runAnalysis(); };
    box.append(b);
  });
}

async function runAnalysis() {
  const pf = $('project-file').files[0];
  if (!pf) return;
  $('project-name').textContent = `${pf.name} (${fmtSize(pf.size)})`;
  let bf = $('baseline-file').files[0];
  $('baseline-name').textContent = bf ? `${bf.name} (${fmtSize(bf.size)})` : 'No file chosen';
  for (const id of ['summary-card', 'export-card', 'results-card', 'manifest-card']) $(id).hidden = true;
  $('choose').hidden = true;
  analysis = null;
  setStatus('Reading project…');
  try {
    analysis = await analyse(pf, bf, { sqlOptions, root: roots.project, baselineRoot: roots.baseline });
  } catch (e) {
    if (e instanceof NeedsChoiceError) { setStatus(''); offerChoice(e); return; }
    if (e instanceof SameFileError) {
      $('baseline-file').value = '';
      $('baseline-name').textContent = 'No file chosen';
      clearCache('baseline');
      try { analysis = await analyse(pf, null, { sqlOptions, root: roots.project }); } catch (e2) { setStatus(e2.message, true); return; }
      setStatus(e.message, true);
      showSummary(analysis);
      return;
    }
    console.error(e);
    setStatus(e.message || 'Could not read that project.', true);
    return;
  }
  setStatus('');
  showSummary(analysis);
}

function showSummary(a) {
  const s = a.summary;
  const rows = [
    ['Project', s.name], ['Tempo', s.tempoText], ['Length', s.lengthText],
    ['Instruments', s.instruments], ['Colour groups', s.groups], ['Effects', s.effects], ['Buses', s.buses],
    ['Automation lanes', s.lanes], ['Stems', s.stems],
  ];
  $('summary').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${String(v).replace(/</g, '&lt;')}</dd></div>`).join('');
  $('warnings').innerHTML = s.warnings.length
    ? `<div class="warn"><h3>Worth knowing</h3><ul>${s.warnings.map((w) => `<li>${w.replace(/</g, '&lt;')}</li>`).join('')}</ul></div>` : '';
  $('stem-list').textContent = a.stems.map((x) => x.filename.replace(/\.wav$/, '')).join(' · ');
  $('midi-list').textContent = a.mixer.instruments.map((i) => i.name).join(' · ');
  $('o-stems').disabled = a.stems.length === 0 && a.allStems.length === 0;
  if ($('o-stems').disabled) $('o-stems').checked = false;
  $('o-midi').disabled = a.mixer.instruments.length === 0 || !a.summary.hasArrangement;
  if ($('o-midi').disabled) $('o-midi').checked = false;
  $('summary-card').hidden = false;
  $('export-card').hidden = false;
  $('manifest').innerHTML = renderMarkdown(manifestFor(a));
  $('manifest-card').hidden = false;
}

function trigger(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function share(f) {
  const file = new File([f.blob], f.name, { type: f.blob.type });
  try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') setStatus(`Could not share ${f.name}: ${e.message}`, true); }
}

function showResults() {
  const canShare = (f) => navigator.canShare && navigator.canShare({ files: [new File([f.blob], f.name, { type: f.blob.type })] });
  $('files').innerHTML = '';
  files.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="meta"><div class="name"></div><div class="sub"></div></div><div class="btns"></div>`;
    li.querySelector('.name').textContent = f.name;
    li.querySelector('.sub').textContent = `${f.folder || 'Manifest'} · ${fmtSize(f.size)}${f.shifted?.length ? ` · pitch-shifted: ${f.shifted.join(', ')}` : ''}${f.note ? ` · ${f.note}` : ''}`;
    const btns = li.querySelector('.btns');
    const dl = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Download' });
    dl.onclick = () => trigger(f.blob, f.name);
    btns.append(dl);
    if (canShare(f)) {
      const sh = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Share / Save to Files' });
      sh.onclick = () => share(f);
      btns.append(sh);
    }
    $('files').append(li);
  });
  $('results-card').hidden = false;
  $('results-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function doExport() {
  if (!analysis || busy) return;
  const options = {
    stems: $('o-stems').checked, midi: $('o-midi').checked, automation: $('o-auto').checked, manifest: $('o-manifest').checked,
    includeSuperseded: $('o-superseded').checked, includeUnused: $('o-unused').checked,
  };
  if (!Object.entries(options).some(([k, v]) => ['stems', 'midi', 'automation', 'manifest'].includes(k) && v)) {
    setStatus('Choose at least one output.', true); return;
  }
  busy = true;
  $('export-btn').disabled = true;
  $('progress').hidden = false;
  setStatus('');
  try {
    files = await runExport(analysis, options, ({ label, fraction }) => {
      $('bar').value = fraction;
      if (label) $('progress-label').textContent = label;
    });
    showResults();
  } catch (e) {
    console.error(e);
    setStatus(`Export failed: ${e.message}`, true);
  } finally {
    busy = false;
    $('export-btn').disabled = false;
    $('progress-label').textContent = '';
    $('progress').hidden = true;
  }
}

async function doZip() {
  $('zip-btn').disabled = true;
  $('zip-btn').textContent = 'Building zip…';
  try {
    const root = `${analysis.summary.name} – Logic migration`;
    const blob = await zipFiles(files, () => {}, root);
    trigger(blob, `${root}.zip`);
  } catch (e) {
    setStatus(`Could not build the zip (${e.message}). Save the files one at a time instead.`, true);
  } finally {
    $('zip-btn').disabled = false;
    $('zip-btn').textContent = 'Download everything as one zip';
  }
}

$('project-file').addEventListener('change', runAnalysis);
$('baseline-file').addEventListener('change', runAnalysis);
$('export-btn').addEventListener('click', doExport);
$('zip-btn').addEventListener('click', doZip);

// Test hook: lets automated checks load fixtures without the file picker
window.__loopy = { reset: () => { roots.project = roots.baseline = undefined; clearCache(); }, analyse: (p, b) => { const dt = new DataTransfer(); dt.items.add(p); $('project-file').files = dt.files; if (b) { const d2 = new DataTransfer(); d2.items.add(b); $('baseline-file').files = d2.files; } return runAnalysis(); } };
