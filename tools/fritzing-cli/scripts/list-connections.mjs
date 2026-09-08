// Lists every wire connection in a sketch: wire endpoints resolved to part titles and pin names.
import AdmZip from 'adm-zip';
import { readFileSync } from 'node:fs';

const sketchPath = process.argv[2];
const buffer = readFileSync(sketchPath);
const xml = sketchPath.toLowerCase().endsWith('.fzz')
  ? new AdmZip(buffer).getEntries().find(e => e.entryName.toLowerCase().endsWith('.fz')).getData().toString('utf8')
  : buffer.toString('utf8');

const instances = [...xml.matchAll(/<instance\b([^>]*)>([\s\S]*?)<\/instance>/gi)].map(m => ({
  attrs: m[1] ?? '',
  body: m[2] ?? '',
  moduleIdRef: (m[1] ?? '').match(/moduleIdRef="([^"]+)"/i)?.[1] ?? '',
  modelIndex: (m[1] ?? '').match(/modelIndex="([^"]+)"/i)?.[1] ?? '',
  title: ((m[2] ?? '').match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
}));

const byIndex = new Map(instances.map(i => [i.modelIndex, i]));
const wires = instances.filter(i => i.moduleIdRef === 'WireModuleID');
const partsOnly = instances.filter(i => i.moduleIdRef !== 'WireModuleID');

console.log(`Parts (${partsOnly.length}):`);
for (const part of partsOnly) {
  console.log(`  ${part.title || '(untitled)'} [${part.moduleIdRef}]`);
}

console.log(`\nWires (${wires.length}):`);
for (const wire of wires) {
  const bb = wire.body.match(/<breadboardView[^>]*>([\s\S]*?)<\/breadboardView>/i)?.[1] ?? '';
  const color = bb.match(/color="([^"]+)"/i)?.[1] ?? '?';
  const connects = [...bb.matchAll(/<connect\b[^>]*connectorId="([^"]+)"[^>]*modelIndex="([^"]+)"/gi)]
    .map(c => {
      const target = byIndex.get(c[2]);
      const name = target && target.moduleIdRef !== 'WireModuleID'
        ? `${target.title || target.moduleIdRef}:${c[1]}`
        : `wire:${target?.title ?? c[2]}`;
      return name;
    });
  console.log(`  ${wire.title} (${color}): ${connects.join(' <-> ') || 'FLOATING (no connections)'}`);
}
