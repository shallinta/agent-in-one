import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PairMessageForm } from '../src/pair-message-form.js';

function result(delivery: 'delivered' | 'pending' = 'delivered'): Response {
  return {
    ok: true,
    status: 202,
    json: async () => ({
      acceptedAtLedgerHead: 8,
      deliveryId: 'pair-form:8',
      delivery,
    }),
  } as Response;
}

function renderForm(
  role: 'navigator' | 'pilot',
  fetcher: typeof fetch,
  ledgerHead = 7,
) {
  return render(
    <PairMessageForm
      apiBase="https://pair.example"
      pairId="pair-form"
      role={role}
      ledgerHead={ledgerHead}
      fetcher={fetcher}
    />,
  );
}

describe.each(['navigator', 'pilot'] as const)('PairMessageForm for %s', (role) => {
  test('submits the pane role with the current Ledger head and clears on success', async () => {
    const fetcher = vi.fn(async () => result());
    renderForm(role, fetcher);
    const input = screen.getByRole('textbox', { name: `Message ${role}` });
    fireEvent.change(input, { target: { value: `hello ${role}` } });
    fireEvent.click(screen.getByRole('button', { name: `Send to ${role}` }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledWith(
      `https://pair.example/api/pairs/pair-form/messages/${role}`,
      expect.objectContaining({
        body: JSON.stringify({ text: `hello ${role}`, expectedLedgerHead: 7 }),
      }),
    );
    await waitFor(() => expect(input).toHaveValue(''));
  });

  test('clears a pending draft and explains that durable input awaits delivery', async () => {
    renderForm(role, vi.fn(async () => result('pending')));
    const input = screen.getByRole('textbox', { name: `Message ${role}` });
    fireEvent.change(input, { target: { value: 'durable message' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('status')).toHaveTextContent(/saved, awaiting delivery/i);
    expect(input).toHaveValue('');
  });

  test('retains a stale draft, waits for the Projection head and retries only explicitly', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: 'LEDGER_CONFLICT',
            message: 'stale',
            details: { expectedLedgerHead: 7, actualLedgerHead: 9 },
          },
        }),
      } as Response)
      .mockResolvedValueOnce(result());
    const view = renderForm(role, fetcher, 7);
    const input = screen.getByRole('textbox', { name: `Message ${role}` });
    fireEvent.change(input, { target: { value: 'keep this draft' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByText(/waiting for projection head 9/i)).toBeInTheDocument();
    expect(input).toHaveValue('keep this draft');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'edited but still gated' } });
    expect(screen.getByText(/waiting for projection head 9/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Send to ${role}` })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(1);

    view.rerender(
      <PairMessageForm
        apiBase="https://pair.example"
        pairId="pair-form"
        role={role}
        ledgerHead={9}
        fetcher={fetcher}
      />,
    );
    const retry = screen.getByRole('button', { name: `Retry ${role} message` });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({
      text: 'edited but still gated',
      expectedLedgerHead: 9,
    });
  });

  test('resets draft state when Pair identity changes', () => {
    const fetcher = vi.fn(async () => result());
    const view = render(
      <PairMessageForm
        apiBase="https://pair.example"
        pairId="pair-a"
        role={role}
        ledgerHead={7}
        fetcher={fetcher}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: `Message ${role}` }), {
      target: { value: 'pair A only' },
    });

    view.rerender(
      <PairMessageForm
        apiBase="https://pair.example"
        pairId="pair-b"
        role={role}
        ledgerHead={9}
        fetcher={fetcher}
      />,
    );

    expect(screen.getByRole('textbox', { name: `Message ${role}` })).toHaveValue('');
  });

  test('retains an ambiguous network-failure draft and never retries automatically', async () => {
    const fetcher = vi.fn(async () => Promise.reject(new TypeError('network down')));
    renderForm(role, fetcher);
    const input = screen.getByRole('textbox', { name: `Message ${role}` });
    fireEvent.change(input, { target: { value: 'possibly accepted' } });
    fireEvent.submit(input.closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/outcome unknown/i);
    expect(input).toHaveValue('possibly accepted');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
