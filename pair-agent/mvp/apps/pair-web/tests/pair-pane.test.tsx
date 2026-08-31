import { render, screen } from '@testing-library/react';

import { PairPane, buildPairPaneSrc } from '../src/pair-pane.js';

describe('PairPane', () => {
  test('builds an encoded addressed-session URL from the validated descriptor', () => {
    const src = buildPairPaneSrc(
      'https://dsh.example/',
      'https://shell.example',
      {
        pairId: 'pair-url',
        role: 'navigator',
        source: 'navigator-session',
        sessionId: 'session / ? & = value',
      },
    );

    const url = new URL(src);
    expect(url.origin).toBe('https://dsh.example');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('embedded')).toBe('1');
    expect(url.searchParams.get('pairId')).toBe('pair-url');
    expect(url.searchParams.get('pane')).toBe('navigator');
    expect(url.searchParams.get('session')).toBe('session / ? & = value');
    expect(url.searchParams.get('expectedSession')).toBe('session / ? & = value');
  });

  test.each([
    'javascript:alert(1)',
    'file:///tmp/dsh',
    'https://user:secret@dsh.example',
    'https://dsh.example/#spoofed',
    'https://dsh.example/?tenant=spoofed',
    'https://dsh.example/not-an-origin',
  ])('rejects invalid DSH origin %s without mounting an iframe', (origin) => {
    render(
      <PairPane
        dshWebOrigin={origin}
        shellOrigin="https://shell.example"
        pane={{
          pairId: 'pair-origin',
          role: 'pilot',
          source: 'pilot-session',
          sessionId: 'pair:pair-origin:pilot',
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('DSH Web origin');
    expect(screen.queryByTitle('Pilot DSH session')).not.toBeInTheDocument();
  });

  test('rejects a DSH origin equal to the Pair Shell origin', () => {
    render(
      <PairPane
        dshWebOrigin="https://shell.example/"
        shellOrigin="https://shell.example"
        pane={{
          pairId: 'pair-origin',
          role: 'pilot',
          source: 'pilot-session',
          sessionId: 'pair:pair-origin:pilot',
        }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/separate origin/i);
    expect(screen.queryByTitle('Pilot DSH session')).not.toBeInTheDocument();
  });

  test('allows localhost DSH and Shell origins on different ports', () => {
    expect(() =>
      buildPairPaneSrc(
        'http://localhost:3001',
        'http://localhost:3000',
        {
          pairId: 'pair-ports',
          role: 'navigator',
          source: 'navigator-session',
          sessionId: 'pair:pair-ports:navigator',
        },
      ),
    ).not.toThrow();
  });

  test('uses a fixed role label and explains the native DSH boundary', () => {
    render(
      <PairPane
        dshWebOrigin="http://localhost:3000"
        shellOrigin="http://localhost:5173"
        pane={{
          pairId: 'pair-label',
          role: 'navigator',
          source: 'navigator-session',
          sessionId: 'pair:pair-label:navigator',
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Navigator' })).toBeInTheDocument();
    expect(screen.getByText(/Isolated native DSH session/i)).toBeInTheDocument();
    const iframe = screen.getByTitle('Navigator DSH session');
    expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-downloads',
    );
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByRole('status', { name: /Navigator session loading/i })).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });
});
