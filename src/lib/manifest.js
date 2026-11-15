// Generate the effects manifest (Markdown, British English, en dashes only).
import { effectChanges, instrumentChanges } from './baseline.js';

const pct = (v) => `${Math.round(v * 100 + 1e-6)}%`;
const n2 = (v) => (Math.round(v * 100) / 100).toString().replace('-', '−');
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100) / 100)}`;
const levelText = (g, db) => (Math.abs(db) < 0.05 ? '' : ` Level ${signed(Math.round(db * 10) / 10)} dB.`);
const busName = (l) => `**Bus ${l}**`;
const camelWords = (k) => (/^[a-z]{2,5}$/.test(k) ? k : k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/Lfo/g, 'LFO'));
const sendText = (sends) => {
  if (!sends.length) return 'No sends.';
  const nz = sends.filter((s) => s.amount > 0.0005);
  const z = sends.filter((s) => s.amount <= 0.0005);
  const parts = nz.map((s) => `${pct(s.amount)} to ${busName(s.bus)}`);
  if (z.length) parts.push(`${nz.length ? 'and ' : ''}${z.map((s) => busName(s.bus)).join(', ')} at 0%`);
  return `Sends ${parts.join(', ')}.`;
};

function formatChange(effect, c, opts) {
  const { odc } = opts;
  const t = effect.title;
  if (/^AudioScope/i.test(t)) {
    if (c.key === 'eq_enable') return null;
    const m = c.key.match(/^eq_band_(\d+)$/);
    return m ? { text: `Band ${m[1]} ${signed(c.to)}`, band: Number(m[1]), to: c.to } : { text: `${camelWords(c.key)} ${n2(c.from)} → ${n2(c.to)}` };
  }
  if (/Other Desert Cities/i.test(t)) {
    const name = odc.names[Number(c.key)] ?? `Parameter ${c.key}`;
    if (name === 'Algorithm') return { text: `Algorithm: Algo0${c.from + 1} → **Algo0${c.to + 1}**` };
    const selected = Math.round(Number(effect.params['7'] ?? 0)) + 1;
    const am = name.match(/^Algo0(\d):/);
    const inactive = !!(am && Number(am[1]) !== selected);
    if (odc.switches.includes(name)) return { text: `${name}: ${c.from} → ${c.to}`, name, inactive };
    return { text: `${name}: ${pct(c.from)} → ${pct(c.to)}`, inactive, name };
  }
  if (/Turnado/i.test(t)) return null; // reported in section 6
  return { text: `${camelWords(c.key)} ${n2(c.from)} → ${n2(c.to)}` };
}

export function generateManifest(ctx) {
  const { mixer, lanes, targets, baseline, lookups, projectName, baselineName, odc, automationMapping } = ctx;
  const L = [];
  const push = (...x) => L.push(...x);
  const hasBaseline = !!baseline;

  // All effect owners in a flat list (for checklist and tweaks)
  const owners = [];
  mixer.instruments.forEach((i) => i.effects.forEach((e, k) => owners.push({ where: `${i.name}, slot ${k + 1}`, label: i.name, e })));
  mixer.groups.forEach((g) => g.effects.forEach((e, k) => owners.push({ where: `${g.label} (${g.colour}), slot ${k + 1}`, label: `${g.label} (${g.colour})`, e })));
  mixer.buses.forEach((b) => b.effects.forEach((e) => owners.push({ where: `Bus ${b.letter}`, label: `Bus ${b.letter}`, e })));
  mixer.master.effects.forEach((e, k) => owners.push({ where: `Master, slot ${k + 1}`, label: 'Master', e }));
  const changesFor = new Map();
  if (hasBaseline) for (const o of owners) changesFor.set(o.e, effectChanges(o.e, baseline));
  const tweaked = (e) => (changesFor.get(e)?.changes ?? []).some((c) => !(c.key === 'eq_enable' && /AudioScope/i.test(e.title)));

  const presetLabel = (e) => (e.preset ? e.preset : tweaked(e) ? 'No preset – tweaked' : 'No preset (fresh instance)');

  push(`# ${projectName} – effects manifest`, '',
    `Extracted from the Loopy Pro project \`${projectName}.lpproj\`. It lists every effect and instrument, where each sits in the signal flow and the factory preset it started from${hasBaseline ? `, and the changes made after loading that preset, found by comparing against untouched instances in the baseline project \`${baselineName}\`` : ''}.`, '',
    '**How to read it**', '',
    '- **Preset** is the factory preset last loaded into that instance. Loopy keeps this name even after you tweak controls, so treat it as "started from".',
    '- **Default** means the plug-in\'s own Default preset (or the state it opens in).',
    '- **Pre** / **Post** is the slot position relative to the channel fader in Loopy. In Logic, put pre-fader effects in the normal Audio FX slots; post-fader placement only matters if you automate the fader.',
    '- Channel names follow Loopy\'s mixer labels (instruments with several instances are lettered in mixer order).', '', '---', '');

  // 1 Checklist
  const groups = new Map();
  for (const o of owners) {
    const key = `${o.e.title}||${presetLabel(o.e)}`;
    groups.set(key, { title: o.e.title, preset: presetLabel(o.e), count: (groups.get(key)?.count ?? 0) + 1 });
  }
  const byPlugin = new Map();
  for (const g of groups.values()) byPlugin.set(g.title, [...(byPlugin.get(g.title) ?? []), g]);
  const pluginOrder = [...byPlugin.entries()].sort((a, b) => {
    const na = a[1].every((g) => /^No preset/.test(g.preset)) ? 1 : 0;
    const nb = b[1].every((g) => /^No preset/.test(g.preset)) ? 1 : 0;
    return na - nb || b[1].reduce((s, g) => s + g.count, 0) - a[1].reduce((s, g) => s + g.count, 0);
  });
  push('## 1. Checklist – presets to load in Logic', '', '| Plug-in | Preset | Instances |', '|---|---|---|');
  for (const [, list] of pluginOrder) {
    for (const g of list.sort((a, b) => b.count - a.count)) {
      push(`| ${g.title} | ${/Turnado/i.test(g.title) ? 'Multi-slot – see section 6' : g.preset} | ${g.count} |`);
    }
  }
  push('', `${owners.length} effect instances in total.`, '', '---', '');

  // 2 Instrument channels
  push('## 2. Instrument channels', '');
  for (const i of mixer.instruments) {
    const heading = i.state.kind === 'numa' ? `${i.name === 'Numa Player' ? 'Keys' : i.name} – ${i.module}` : i.state.kind === 'digistix' ? i.name : `${i.name}${i.midiLoops[0] ? ` – ${i.midiLoops[0].split(' ')[0]}` : ''}`;
    push(`### ${heading}`);
    const loops = i.midiLoops.filter(Boolean);
    const played = loops.length ? `Played by MIDI loop **${loops[0]}**` : i.midiTracks.length ? 'Played by an untitled MIDI loop' : 'No MIDI loop assigned';
    push(`${played}${i.sourceGroups.length ? ` (group ${i.sourceGroups[0]})` : ''}. ${i.effects.length ? '' : 'No insert effects. '}${sendText(i.sends)}${levelText(i.gain, i.gainDb)}`, '');
    if (i.effects.length) {
      push('| Slot | Plug-in | Preset | Position |', '|---|---|---|---|');
      i.effects.forEach((e, k) => push(`| ${k + 1} | ${e.title} | ${e.preset ?? (tweaked(e) ? '– (tweaked)' : '–')} | ${e.position} |`));
      push('');
    }
  }
  push('---', '');

  // 3 Audio loop groups
  push('## 3. Audio loop groups', '');
  for (const g of mixer.groups) {
    const audio = g.tracks.filter((t) => t.type === 'audio');
    if (!audio.length) continue;
    const sup = mixer.superseded.filter((s) => s.colour === g.colour && audio.some((t) => t.title === s.track));
    const unused = audio.every((t) => !t.used);
    push(`### ${g.label} – ${g.colour} colour (group ${g.id})`);
    const names = audio.map((t) => `**${t.title}**`).join(' and ');
    const pitch = audio.filter((t) => t.pitch).map((t) => `${t.title} ${t.pitch > 0 ? '+' : ''}${t.pitch} semitones`);
    push(`Contains ${audio.length > 1 ? `${audio.length} loops: ` : 'loop '}${names}. ${g.effects.length ? '' : 'No insert effects. '}${sendText(g.sends)} Volume ${g.volume > 1.001 ? `${signed(Math.round(g.volumeDb * 10) / 10)} dB` : pct(g.volume)}.${pitch.length ? ` Pitch shift: ${pitch.join('; ')}.` : ''}`);
    if (unused) push('', '> **Unused** – this loop is not placed in the arrangement.');
    if (sup.length) push('', `> **Superseded** – same arrangement positions as ${sup[0].replacedBy} (MIDI loop ${sup[0].midiLoop}); the audio loop has probably been replaced by MIDI. Excluded from stems by default.`);
    push('');
    if (g.effects.length) {
      push('| Slot | Plug-in | Preset | Position |', '|---|---|---|---|');
      g.effects.forEach((e, k) => push(`| ${k + 1} | ${e.title} | ${e.preset ?? (tweaked(e) ? '– (tweaked)' : '–')} | ${e.position} |`));
      push('');
    }
  }
  push('---', '');

  // 4 Buses
  push('## 4. Send buses (FX returns) – create as aux channels in Logic', '',
    '| Bus | Effect | Preset | Position | Fed by | Notes |', '|---|---|---|---|---|---|');
  const feeders = (letter) => {
    const out = [];
    mixer.instruments.forEach((i) => i.sends.filter((s) => s.bus === letter).forEach((s) => out.push(`${i.name} (${pct(s.amount)})`)));
    mixer.groups.forEach((g) => g.sends.filter((s) => s.bus === letter).forEach((s) => out.push(`${g.label} (${pct(s.amount)})`)));
    return out.join(', ') || '–';
  };
  for (const b of mixer.buses) {
    const e = b.effects[0];
    const t = targets.find((x) => x.target?.bus === b.letter);
    const note = t ? `${t.lane.title.replace(/ Automation$/, '')} automation (${t.status})` : '';
    push(`| ${b.letter} | ${e?.title ?? '–'} | ${e ? (/Turnado/i.test(e.title) ? 'see section 6' : presetLabel(e)) : '–'} | ${e?.position ?? '–'} | ${feeders(b.letter)} | ${note} |`);
  }
  const loud = mixer.buses.filter((b) => Math.abs(b.gainDb) > 0.05);
  push('', loud.length ? `${loud.map((b) => `Bus ${b.letter}'s output level is ${signed(b.gainDb)} dB`).join('; ')}; all other buses are at 0 dB.` : 'All buses are at 0 dB.', '', '---', '');

  // 5 Master
  push('## 5. Master output', '', '| Slot | Plug-in | Preset | Position |', '|---|---|---|---|');
  mixer.master.effects.forEach((e, k) => push(`| ${k + 1} | ${e.title} | ${e.preset ?? (tweaked(e) ? '– (tweaked)' : '–')} | ${e.position} |`));
  push('');
  if (Math.abs(mixer.master.gainDb) > 0.05 && mixer.master.effects.some((e) => e.position === 'Post')) {
    const post = mixer.master.effects.find((e) => e.position === 'Post');
    push(`The master fader is at ${signed(mixer.master.gainDb)} dB (gain ${mixer.master.gain.toFixed(3)}) and ${post.title} sits after it. Logic has no post-fader inserts, so put a **Gain** plug-in set to ${signed(mixer.master.gainDb)} dB before ${post.title}.`, '');
  }
  push('---', '');

  // 6 Turnado
  const turnados = mixer.buses.flatMap((b) => b.effects.map((e) => ({ b, e }))).filter((x) => x.e.turnado);
  turnados.forEach(({ b, e }) => {
    const strings = e.turnado.strings.map((s) => s.text);
    const slots = strings.slice(0, 8);
    const overall = strings.length > 8 ? strings.at(-1) : null;
    push(`## 6. Turnado (Bus ${b.letter})`, '', `Overall preset: **${overall ?? 'unknown'}**.`, '',
      '| Slot | Sub-preset (stored) | Effect family | Knob position when saved |', '|---|---|---|---|');
    slots.forEach((s, k) => {
      const fam = lookups.turnado?.[s] ?? 'to confirm';
      push(`| ${k + 1} | ${s} | ${fam} | ${Math.round((Number(e.params[String(k)] ?? 0)) * 127)} of 127 |`);
    });
    push('', 'The stored text is the sub-preset loaded into each slot; the effect family comes from the editable lookup `data/turnado-subpresets.json` ("to confirm" where it is missing).', '', '---', '');
  });

  // 7 Automation
  push('## 7. Automation lanes and what they probably drive', '',
    'Each lane is a long MIDI loop sending a single controller (CC0) into Loopy, where it moves an on-screen slider. Loopy does not store which control each slider is bound to, so targets are proposed from the project data (a final value matching a saved send level) or taken from your confirmed list.', '',
    automationMapping ? '| Automation lane | Final value | Probable target | Status | In the MIDI file |' : '| Automation lane | Final value | Probable target | Status |', automationMapping ? '|---|---|---|---|---|' : '|---|---|---|---|');
  for (const t of targets) {
    const tgt = t.target ? `Send level, ${t.target.source} → Bus ${t.target.bus}` : t.candidates?.length ? `One of: ${t.candidates.map((c) => `${c.source} → Bus ${c.bus}`).join('; ')}` : 'Unknown';
    const mp = automationMapping?.find((m) => m.lane === t.lane.title);
    push(`| ${t.lane.title} | ${t.lane.finalValue} of 127 | ${tgt} | ${t.status === 'to confirm' ? 'to confirm' : `**${t.status}**`} |${mp ? ` CC${mp.cc}, channel ${mp.channel} |` : ''}`);
  }
  push('', 'In Logic these become send-level automation on the source track.', '', '---', '');

  // 8 Instruments
  push('## 8. Instruments', '', hasBaseline ? '| Channel | Instrument | Preset / kit | Tweaks from preset |' : '| Channel | Instrument | Preset / kit |', hasBaseline ? '|---|---|---|---|' : '|---|---|---|');
  for (const i of mixer.instruments) {
    const preset = i.state.kind === 'j6' ? `${i.state.bank} › ${i.state.preset}` : i.state.preset ?? i.state.note ?? 'unknown';
    let tw = '';
    if (hasBaseline) {
      const r = instrumentChanges(i, baseline);
      tw = !r.matched ? 'no baseline instance' : r.changes.length ? r.changes.map((c) => `${camelWords(c.key)} ${n2(c.from)} → ${n2(c.to)}`).join(' · ') : 'None';
      if (r.approximate) tw += r.changes.length ? ' (approximate – baseline holds a different sound)' : ' (baseline holds a different sound)';
    }
    push(`| ${i.name} | ${i.module} | ${preset} | ${tw} |`.replace(/ \|  \|$/, ' |'));
  }
  push('', mixer.instruments.some((i) => i.state.kind === 'j6') ? 'J6 shows an asterisk on every preset name, including untouched ones, so the asterisk does not mean "edited". Values are the plug-in\'s own 0–1 scale.' : '', '', '---', '');

  // 9 Effect tweaks
  if (hasBaseline) {
    push('## 9. Effect tweaks from preset', '', 'Compared against untouched instances of each preset. Instances not listed here are exactly as their preset.', '');
    const unchanged = owners.filter((o) => changesFor.get(o.e)?.matched && !tweaked(o.e) && !/Turnado/i.test(o.e.title));
    if (unchanged.length) push(`**Unchanged:** ${unchanged.map((o) => `${o.e.title} (${o.label})`).join(', ')}.`, '');
    const nobase = owners.filter((o) => !changesFor.get(o.e)?.matched);
    if (nobase.length) push(`**No baseline instance:** ${nobase.map((o) => `${o.e.title} (${o.label})`).join(', ')}.`, '');
    push('| Where | Plug-in | Preset | Changes |', '|---|---|---|---|');
    for (const o of owners) {
      const r = changesFor.get(o.e);
      if (!r?.matched || /Turnado/i.test(o.e.title)) continue;
      const items = r.changes.map((c) => formatChange(o.e, c, { odc })).filter(Boolean).sort((a, b) => (a.band ?? 0) - (b.band ?? 0));
      if (!items.length) continue;
      const text = /AudioScope/i.test(o.e.title)
        ? `EQ on · ${items.map((x) => x.text).join(' · ')}`
        : items.filter((x) => !x.inactive).map((x) => x.text).join(' · ') + (items.some((x) => x.inactive) ? ` · *(also ${items.filter((x) => x.inactive).map((x) => x.text).join(', ')} – no effect with the selected algorithm)*` : '');
      push(`| ${o.where} | ${o.e.title} | ${presetLabel(o.e)} | ${text} |`);
    }
    for (const { b, e } of turnados) {
      const r = changesFor.get(e);
      const knobs = r?.changes.filter((c) => /^[0-7]$/.test(c.key)).map((c) => `Knob ${Number(c.key) + 1} set to ${Math.round(c.to * 127)} (of 127)`);
      if (knobs?.length) push('', `**Turnado – Bus ${b.letter}:** ${knobs.join(' · ')}.`);
    }
    push('', '---', '');
  }

  // 10 Warnings
  push(`## ${hasBaseline ? 10 : 9}. To confirm`, '');
  const todo = [];
  targets.filter((t) => t.status === 'to confirm').forEach((t) => todo.push(`Automation lane "${t.lane.title}" – target not determined.`));
  mixer.instruments.filter((i) => i.state.note).forEach((i) => todo.push(`${i.name}: ${i.state.note}.`));
  turnados.forEach(({ e }) => e.turnado.strings.slice(0, 8).filter((s) => !lookups.turnado?.[s.text]).forEach((s) => todo.push(`Turnado sub-preset "${s.text}" – effect family unknown.`)));
  mixer.unusedTracks.forEach((t) => todo.push(`${t.title} (${t.colour}) is not used in the arrangement.`));
  push(todo.length ? todo.map((t) => `- ${t}`).join('\n') : 'Nothing – every channel, effect, preset, tweak, send and automation target is accounted for.', '');

  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}
