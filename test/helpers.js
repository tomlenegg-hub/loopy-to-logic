import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadProject } from '../src/lib/project.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const DUB = path.join(root, 'dub', 'Adabadaba Dub.lpproj');
export const BASELINE = path.join(root, 'logic', 'Logic Migration Project.lpproj');

export const folderReader = (dir) => (name) => {
  const f = path.join(dir, 'Resources', name);
  return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : undefined;
};

export const loadFixture = (dir) => loadProject(fs.readFileSync(path.join(dir, 'Project.sqlite')));
