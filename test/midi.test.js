import { describe, it, expect, beforeAll } from 'vitest';
import { DUB, folderReader, loadFixture } from './helpers.js';
import { midiChannels, noteCount, trackMidi } from '../src/lib/arrangement.js';

let channels, project;
beforeAll(async () => {
  project = await loadFixture(DUB);
  channels = midiChannels(project, folderReader(DUB));
});

// instrument object id -> expected note count over the whole arrangement
const EXPECTED = { 63: 432, 141: 1050, 168: 4453, 177: 2112, 585: 276, 106: 1242, 114: 91, 115: 160 };

describe('MIDI note counts (acceptance)', () => {
  for (const [id, count] of Object.entries(EXPECTED)) {
    it(`instrument ${id} has ${count} notes`, () => {
      const ch = channels.find((c) => c.instrument.id === Number(id));
      expect(ch).toBeTruthy();
      expect(noteCount(ch.events)).toBe(count);
    });
  }
});

describe('MIDI loop rate (item 6)', () => {
  it('J6 C and D play at 2x rate: loop length halves and notes are not transposed', () => {
    for (const id of [168, 177]) {
      const ch = channels.find((c) => c.instrument.id === id);
      expect(ch.tracks[0].factor).toBe(2);
      expect(ch.tracks.every((t) => t.transpose === 0)).toBe(true);
    }
    // J6 C's loop (track 158, offset 0, rate 2): the first arranged notes are the raw loop's notes at half the time
    const raw = trackMidi(project, project.get(158), folderReader(DUB)).events.filter((e) => e.kind === 'note');
    const got = channels.find((c) => c.instrument.id === 168).tracks[0].events.filter((e) => e.kind === 'note');
    const start = project.refs(project.all('TrackPlaybackSequenceTrack').find((x) => x.data.track._value === 158).data.segments)[0].data.start;
    for (let i = 0; i < 6; i++) {
      expect(got[i].note).toBe(raw[i].note);
      expect(got[i].time).toBeCloseTo(start + raw[i].time / 2, 6);
      expect(got[i].duration).toBeCloseTo(raw[i].duration / 2, 6);
    }
  });
});
