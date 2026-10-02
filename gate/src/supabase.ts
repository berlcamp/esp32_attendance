// The gate's whole server surface: two RPCs in the pta schema, called with the
// anon key. status 0 means the request never got an HTTP answer (refused,
// DNS, timeout) -- the uploader treats it like any other failure.
export interface RpcResult {
  status: number;
  body: string;
}

export type Rpc = (fn: string, args: unknown) => Promise<RpcResult>;

export function createRpc(supabaseUrl: string, anonKey: string, timeoutMs = 15_000): Rpc {
  return async (fn, args) => {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          'Content-Type': 'application/json',
          // pta is invisible to PostgREST without this header AND without
          // being listed under Settings -> API -> Exposed schemas.
          'Content-Profile': 'pta',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return { status: 0, body: err instanceof Error ? err.message : String(err) };
    }
  };
}

// Same hints the firmware printed, plus the device token. Order matters: the
// specific 42501 messages are checked before the generic one.
export function explainFailure(body: string, deviceId: string): string | null {
  if (body.includes('PGRST106')) {
    return "schema 'pta' is not exposed: Dashboard -> Settings -> API -> Exposed schemas -> add it";
  }
  if (body.includes('PGRST202')) {
    return 'function not found: apply the pta-collections migrations (0013, 0025) in the SQL Editor';
  }
  if (body.includes('unregistered or inactive gate device')) {
    return `device '${deviceId}' is not in pta.gate_devices, or is inactive; scans stay queued until it is`;
  }
  if (body.includes('invalid gate device credentials')) {
    return `GATE_TOKEN does not match device '${deviceId}': run select pta.issue_gate_device_token('${deviceId}') and update /etc/gate/gate.env`;
  }
  if (body.includes('42501')) {
    return 'anon lacks EXECUTE on the function: re-run the grants at the end of its migration';
  }
  return null;
}
