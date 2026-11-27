import { LedgerError, type Ledger } from "../../dist/mcp/shared/ledger.js";

export function connectLedger(url: string, token: string): Ledger {
  return async (path: string, body?: object): Promise<unknown> => {
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok)
      throw new LedgerError(
        response.status,
        path,
        (await response.text()).slice(0, 500),
      );
    return response.json();
  };
}
