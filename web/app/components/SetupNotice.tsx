export function SetupNotice({ error, hint }: { error: string; hint?: string | null }) {
  const missingEnv = error.includes("SUPABASE_");
  return (
    <div className="border border-amber/40 bg-surface p-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-amber">
        Board not connected
      </div>
      <p className="mt-4 font-mono text-sm text-paper">{error}</p>
      {hint && <p className="mt-2 font-mono text-xs text-muted">{hint}</p>}

      {missingEnv ? (
        <div className="mt-6 space-y-3 text-sm text-muted">
          <p className="text-paper">Create <code className="text-amber">web/.env.local</code>:</p>
          <pre className="overflow-x-auto border border-rule bg-ink p-4 font-mono text-[11px] leading-relaxed text-muted">
{`SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
GATE_DEVICE_ID=gate-01
SCHOOL_TZ=Asia/Manila`}
          </pre>
          <p>
            The service_role key is server-side only — it never reaches the
            browser. Restart <code className="text-amber">npm run dev</code> after adding it.
          </p>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted">
          If this says permission denied, apply{" "}
          <code className="text-amber">0013_gate_attendance.sql</code> from the
          pta-collections repo — its closing grants are what give the service
          role access to the <code className="text-amber">pta</code> schema. If
          it says the gate device is not registered, run{" "}
          <code className="text-amber">sql/cutover.sql</code>.
        </p>
      )}
    </div>
  );
}
