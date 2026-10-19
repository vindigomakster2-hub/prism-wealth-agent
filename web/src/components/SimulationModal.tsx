import { useEffect, useState } from "react";
import { Play, X } from "lucide-react";
import { useApp } from "../App";
import { api, type StressInput, type StressResult } from "../api";
import { EMPTY_STRESS, StressBuilder, StressResultView } from "./Stress";
import { useToast } from "./ui";

export function SimulationModal({ onClose }: { onClose: () => void }) {
  const { sim, setSim, go, refresh } = useApp();
  const toast = useToast();
  const [s, setS] = useState<StressInput>(sim?.input ?? { ...EMPTY_STRESS, equitiesPct: -25, cryptoPct: -30, privatePct: -30 });
  const [r, setR] = useState<StressResult | null>(null);

  useEffect(() => {
    const t = setTimeout(() => api.stress(s).then(setR).catch(() => undefined), 150);
    return () => clearTimeout(t);
  }, [s]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const preview = () => {
    if (!r) return;
    setSim({ input: s, result: r });
    go("overview");
    onClose();
  };
  const replay = async () => {
    try {
      await api.crash(Math.min(80, Math.abs(s.cryptoPct)));
      toast("info", `Replaying ETH ${s.cryptoPct}% on-chain in 5 steps. The autopilot is live.`);
      setSim(null);
      go("lab");
      onClose();
      await refresh();
    } catch (e) {
      toast("bad", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New simulation">
        <div className="between">
          <div>
            <h3 className="card-title">New simulation</h3>
            <div className="card-sub">Pick a scenario or build your own, then preview it on every position of the map</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="grid g-2" style={{ gap: 22, marginTop: 14 }}>
          <StressBuilder value={s} onChange={setS} />
          <div>{r ? <StressResultView r={r} /> : <div className="empty">Calculating…</div>}</div>
        </div>
        <div className="row-flex" style={{ marginTop: 18, justifyContent: "flex-end" }}>
          <button className="btn" onClick={replay} disabled={s.cryptoPct >= 0} title={s.cryptoPct >= 0 ? "Set a negative ETH move to replay it on-chain" : undefined}>
            <Play size={15} /> Replay ETH move on-chain
          </button>
          <button className="btn lime" disabled={!r} onClick={preview}>Preview on the map</button>
        </div>
      </div>
    </div>
  );
}
