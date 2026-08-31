import { readFile } from 'node:fs/promises';

describe('Pair Web production entrypoints', () => {
  test('provides the documented pair.html URL without a separate application', async () => {
    const html = await readFile('pair.html', 'utf8');

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/src/main.tsx"');
  });
});
