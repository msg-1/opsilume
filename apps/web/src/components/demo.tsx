'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, FormError } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

/** Whether this deployment is the public demonstration. The API decides and enforces; this only shows it. */
export function useDemoMode(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<{ enabled: boolean }>('/auth/demo')
      .then((r) => live && setEnabled(r.enabled))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}

/** The entry to the public demonstration: no password, no account of your own. */
export function DemoEntry() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function enter() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/demo');
      router.replace('/incidents');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="demo-heading" className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-4">
      <h2 id="demo-heading" className="text-base font-semibold">Explore the public demo</h2>
      <p className="text-[13px] text-ink-2">
        OPSILUME correlates logs, metrics, deployments, code changes and past incidents to rank probable causes with the evidence for and against them, and says what it cannot tell.
        This demo is a fictional company, <span className="font-medium text-ink">Acme Commerce</span>, with active incidents to investigate.
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">
        <li>Fictional, seeded data that is reset regularly. Nothing here touches a real system.</li>
        <li>Read-only, except that you can start an investigation.</li>
        <li>Analyses use the built-in rule-based engine, not a language model, and say so.</li>
      </ul>
      <FormError error={error} />
      <Button type="button" variant="primary" loading={busy} onClick={() => void enter()} className="w-full">
        Explore the demo
      </Button>
    </section>
  );
}

/** Shown on every page to the demo visitor. */
export function DemoBanner() {
  const { demoVisitor } = useSession();
  if (!demoVisitor) return null;
  return (
    <div role="note" className="border-b border-accent/30 bg-accent/5 px-4 py-2 text-[12.5px] text-ink-2 lg:px-8 print:hidden">
      <span className="font-medium text-ink">Public demo.</span> Fictional data (Acme Commerce), reset regularly. You can browse everything and start an investigation; other changes are
      not available. Investigations use the rule-based engine, not a language model.
    </div>
  );
}
