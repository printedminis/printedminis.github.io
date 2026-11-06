// Runs the 3MF reader off the main thread so the page never freezes.
import { parse3MF } from './parse3mf.js';

self.onmessage = (e) => {
  const { id, buffer, fileName } = e.data;
  try {
    const result = parse3MF(buffer, fileName, (stage) => self.postMessage({ id, stage }));
    const transfer = [];
    for (const p of result.plates) transfer.push(p.positions.buffer, p.colors.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};
