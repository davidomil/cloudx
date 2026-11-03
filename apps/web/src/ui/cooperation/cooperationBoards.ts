import { useCallback, useEffect, useState } from "react";
import type { CooperationBoardSummary } from "@cloudx/shared";
import { listCooperationBoards, subscribeCooperationBoards } from "../../cooperationApi.js";

export function useCooperationBoards(enabled = true, membershipKey = "") {
  const [boards, setBoards] = useState<CooperationBoardSummary[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(enabled);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const reload = useCallback(async () => setConnectionAttempt(attempt => attempt + 1), []);
  useEffect(() => {
    if (!enabled) { setBoards([]); return; }
    let disposed = false;
    let currentSnapshot = false;
    setLoading(true);
    void listCooperationBoards().then(value => { if (!disposed && !currentSnapshot) { setBoards(value); setError(undefined); } }).catch(cause => { if (!disposed && !currentSnapshot) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!disposed) setLoading(false); });
    const unsubscribe = subscribeCooperationBoards({
      boards: value => { if (!disposed) { currentSnapshot = true; setBoards(value); setError(undefined); setLoading(false); } },
      disconnected: reason => { if (!disposed) { setError(reason); setLoading(false); } }
    });
    return () => { disposed = true; unsubscribe(); };
  }, [enabled, membershipKey, connectionAttempt]);
  return { boards, error, loading, reload };
}
