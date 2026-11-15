// Generate the effects manifest (Markdown, British English, en dashes only).
import { effectChanges, instrumentChanges } from './baseline.js';
import { fmtDb, isUnity, ccToGain } from './levels.js';

const pct = (v) => `${Math.round(v * 100 + 1e-6)}%`;
const n2 = (v) => (Math.round(v * 100) / 100).toString().replace('-', '−');
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100) / 100)}`;
const levelText = (g) => (isUnity(g) ? '' : ` Level ${fmtDb(g)}.`);
const busName = (l) => `**Bus ${l}**`;
const camelWords = (k) => (/^[a-z]{2,5}$/.test(k) ? k : k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/Lfo/g, 'LFO'));
const sendText = (sends) => {
  if (!sends.length) return 'No sends.';
  const nz = sends.filter((x) => x.amount > 0);
  const z = sends.filter((x) => !(x.amount > 0));
  const parts = nz.map((x) => `${fmtDb(x.amount)} to ${busName(x.bus)}`);
  if (z.length) parts.push(`${nz.length ? 'and ' : ''}${z.map((x) => busName(x.bus)).join(', ')} off`);
  return `Sends ${parts.join(', ')}.`;
};
const trackLevel = (g) => (isUnity(g) ? '' : fmtDb(g));
const rateWarning = (t) => {
  const f = t.rate * t.speed;
  const semis = Math.abs(Math.round(12 * Math.log2(f)));
  const speedNote = t.speed !== 1 ? ` (rate ${t.rate}, speed ${t.speed})` : '';
  return `Loopy plays this loop at ${Number.isInteger(f) ? f : f.toFixed(2)}× rate${speedNote}, so the MIDI file is already sped up to match. If it sounds ${semis ? 'an octave' : 'in a different register'} too high or low compared with Loopy, set Transpose to −${semis || 12} or +${semis || 12} in the Region inspector.`;
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
    push(`${played}${i.sourceGroups.length ? ` (group ${i.sourceGroups[0]})` : ''}. ${i.effects.length ? '' : 'No insert effects. '}${sendText(i.sends)}${levelText(i.gain)}`, '');
    const loopVol = i.midiTracks.filter((t) => !isUnity(t.volume));
    if (loopVol.length) push(`Loop volume in Loopy: ${loopVol.map((t) => `${t.title ?? 'untitled'} ${fmtDb(t.volume)}`).join('; ')} (not applied to the MIDI file).`, '');
    i.midiTracks.filter((t) => t.rate !== 1 || t.speed !== 1).forEach((t) => push(`> **Rate** – ${rateWarning(t)}`, ''));
    if (i.internal) {
      const on = i.internal.info.map((x) => `${x.label} ${x.on ? 'on' : 'off'}`).join(', ');
      push(`> **Internal sequencer** – ${i.internal.label}: ${i.internal.active.join(' and ')} on (${on}). This preset uses it. If it stalls in Logic, ${i.internal.advice}.`, '');
    }
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
    const names = audio.map((t) => `**${t.display}**`).join(' and ');
    const pitch = audio.filter((t) => t.pitch).map((t) => `${t.title} ${t.pitch > 0 ? '+' : ''}${t.pitch} semitones`);
    push(`Contains ${audio.length > 1 ? `${audio.length} loops: ` : 'loop '}${names}. ${g.effects.length ? '' : 'No insert effects. '}${sendText(g.sends)} Volume ${fmtDb(g.volume)}.${audio.filter((t) => !isUnity(t.volume)).map((t) => ` Loop volume: ${t.display} ${fmtDb(t.volume)}.`).join('')}${pitch.length ? ` Pitch shift: ${pitch.join('; ')}.` : ''}`);
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
    mixer.instruments.forEach((i) => i.sends.filter((s) => s.bus === letter).forEach((s) => out.push(`${i.name} (${fmtDb(s.amount)})`)));
    mixer.groups.forEach((g) => g.sends.filter((s) => s.bus === letter).forEach((s) => out.push(`${g.label} (${fmtDb(s.amount)})`)));
    return out.join(', ') || '–';
  };
  for (const b of mixer.buses) {
    const e = b.effects[0];
    const t = targets.find((x) => x.target?.bus === b.letter);
    const note = t ? `${t.lane.title.replace(/ Automation$/, '')} automation (${t.status})` : '';
    push(`| ${b.letter} | ${e?.title ?? '–'} | ${e ? (/Turnado/i.test(e.title) ? 'see section 6' : presetLabel(e)) : '–'} | ${e?.position ?? '–'} | ${feeders(b.letter)} | ${note} |`);
  }
  const loud = mixer.buses.filter((b) => !isUnity(b.gain));
  push('', loud.length ? `${loud.map((b) => `Bus ${b.letter}'s output level is ${fmtDb(b.gain)}`).join('; ')}; all other buses are at 0.0 dB.` : 'All buses are at 0.0 dB.', '', '---', '');

  // 5 Master
  push('## 5. Master output', '', '| Slot | Plug-in | Preset | Position |', '|---|---|---|---|');
  mixer.master.effects.forEach((e, k) => push(`| ${k + 1} | ${e.title} | ${e.preset ?? (tweaked(e) ? '– (tweaked)' : '–')} | ${e.position} |`));
  push('');
  push(`Master fader: ${fmtDb(mixer.master.gain)}.`, '');
  if (!isUnity(mixer.master.gain) && mixer.master.effects.some((e) => e.position === 'Post')) {
    const post = mixer.master.effects.find((e) => e.position === 'Post');
    push(`${post.title} sits after the master fader. Logic has no post-fader inserts, so put a **Gain** plug-in set to ${fmtDb(mixer.master.gain)} before ${post.title}.`, '');
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
    '**Level conversion:** a CC value n sets a linear gain of n/128 (for example 38 → 0.297 = −10.5 dB; 0 = off). The MIDI file keeps the raw CC values; convert to dB when drawing send automation in Logic.', '',
    automationMapping ? '| Automation lane | Final value | Probable target | Status | In the MIDI file |' : '| Automation lane | Final value | Probable target | Status |', automationMapping ? '|---|---|---|---|---|' : '|---|---|---|---|');
  for (const t of targets) {
    const tgt = t.target ? `Send level, ${t.target.source} → Bus ${t.target.bus}` : t.candidates?.length ? `One of: ${t.candidates.map((c) => `${c.source} → Bus ${c.bus}`).join('; ')}` : 'Unknown';
    const mp = automationMapping?.find((m) => m.lane === t.lane.title);
    push(`| ${t.lane.title} | ${t.lane.finalValue} of 127 (${t.lane.finalValue === 0 ? 'off' : fmtDb(ccToGain(t.lane.finalValue))}) | ${tgt} | ${t.status === 'to confirm' ? 'to confirm' : `**${t.status}**`} |${mp ? ` CC${mp.cc}, channel ${mp.channel} |` : ''}`);
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

  // 10 Importing into Logic
  const n = hasBaseline ? 10 : 9;
  push(`## ${n}. Importing into Logic (iPad)`, '',
    'On the iPad every import into Logic goes through the Files app, so set up a split screen first:', '',
    '1. Turn on **Windowed Apps** or **Stage Manager** (Settings → Multitasking & Gestures).',
    '2. Open **Logic Pro** and the **Files** app side by side, and open the exported folder in Files.',
    '3. Select several files at once (tap **Select**, or press and hold one and tap the others) and drag them into Logic.',
    '4. Drop each file onto its own track at **bar 1**: `MIDI/` files onto the instrument tracks, `Audio/` files onto audio tracks, and `Automation/` onto a spare track to read the lanes.',
    '5. Check the levels and effects against the sections above, and set the colour-group faders, send levels and bus levels in dB.', '',
    '---', '');

  // 11 To confirm
  push(`## ${n + 1}. To confirm`, '');
  const todo = [];
  targets.filter((t) => t.status === 'to confirm').forEach((t) => todo.push(`Automation lane "${t.lane.title}" – target not determined.`));
  mixer.instruments.filter((i) => i.state.note).forEach((i) => todo.push(`${i.name}: ${i.state.note}.`));
  turnados.forEach(({ e }) => e.turnado.strings.slice(0, 8).filter((s) => !lookups.turnado?.[s.text]).forEach((s) => todo.push(`Turnado sub-preset "${s.text}" – effect family unknown.`)));
  mixer.unusedTracks.forEach((t) => todo.push(`${t.display} (${t.colour}) is not used in the arrangement.`));
  push(todo.length ? todo.map((t) => `- ${t}`).join('\n') : 'Nothing in the project data is unresolved.', '');
  push('**Still to confirm by ear**', '',
    '- **Segment offset direction.** MIDI and audio segments carry an offset; its direction is unconfirmed and shifts channels that use one (for example J6 Synth One B and Keys) by up to about half a beat. If a part feels early or late against the stems, nudge the region.',
    '- **MIDI loops with a rate other than 1.** Whether Loopy also transposes such a loop is unconfirmed. The MIDI is not transposed; use the Region inspector\'s Transpose if it sounds an octave out.', '');

  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}
