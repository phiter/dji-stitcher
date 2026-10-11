import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignPhotos } from '../src/lib/align/align';
import { datasetDir, loadAlignInput } from './helpers';

const dir = datasetDir();

describe.skipIf(!fs.existsSync(dir))('real DJI data', () => {
  it('aligns a 26 photo sphere', async () => {
    const { input } = await loadAlignInput(dir);
    const t0 = Date.now();
    const result = await alignPhotos(input, (stage, f) => {
      if (f === 0 || f > 0.99) console.log(stage, f.toFixed(2));
    });
    console.log('align ms', Date.now() - t0);
    console.log('focalRel', result.focalRel, 'f px', result.focalRel * input.gray[0].width, 'k1', result.k1);
    console.log('stats', JSON.stringify(result.stats));
    console.log('vignette', result.vignette);
    console.log('gains', result.gains.map((g) => g.map((v) => v.toFixed(2)).join('/')).join(' '));
    console.log('warnings', result.warnings);
    expect(result.stats.rmsPx).toBeLessThan(3);
  });
});
