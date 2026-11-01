import { useEffect, type ReactNode } from "react";

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal${props.wide ? " wide" : ""}`} role="dialog" aria-label={props.title} data-testid={props.testId}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="icon" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>(props: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; testId?: string }) {
  return (
    <div className="tabs" role="tablist" data-testid={props.testId}>
      {props.tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === props.value} className={t.id === props.value ? "active" : ""} onClick={() => props.onChange(t.id)} data-testid={`tab-${t.id}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
