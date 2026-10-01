/** Lists item shape families by category (dev aid for mesh/wearable coverage). */
import { ITEM_DEFS } from '../src/items/data/catalog';
const by = new Map<string, Set<string>>();
for (const d of ITEM_DEFS) {
  const k = d.slots.length ? d.category + ' [' + d.slots.join(',') + ']' : d.category;
  if (!by.has(k)) by.set(k, new Set());
  by.get(k)!.add(d.visual.shape);
}
for (const [k, s] of by) console.log(k + ': ' + [...s].join(' '));
console.log('defs:', ITEM_DEFS.length);
