import { describe, it, expect, beforeAll } from 'vitest';
import { DUB, folderReader, loadFixture } from './helpers.js';
import { midiChannels, noteCount } from '../src/lib/arrangement.js';

let channels;
beforeAll(async () => {
  const project = await loadFixture(DUB);
  channels = midiChannels(project, folderReader(DUB));
});

// instrument object id -> expected note count over the whole arrangement
const EXPECTED = { 63: 432, 141: 1050, 168: 2226, 177: 1054, 585: 276, 106: 1242, 114: 91, 115: 160 };

describe('MIDI note counts (acceptance)', () => {
  for (const [id, count] of Object.entries(EXPECTED)) {
    it(`instrument ${id} has ${count} notes`, () => {
      const ch = channels.find((c) => c.instrument.id === Number(id));
      expect(ch).toBeTruthy();
      expect(noteCount(ch.events)).toBe(count);
    });
  }
});
