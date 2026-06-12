import { EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { ControlButton } from "./Control.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";

export interface PluginPanelDockItem {
  id: string;
  label: string;
  icon: ReactNode;
  children: ReactNode;
  visible?: boolean;
  showLabel?: string;
  hideLabel?: string;
  onVisibleChange?: (visible: boolean) => void;
  onOpenChange?: (open: boolean) => void;
}

export function PluginPanelDock({
  items,
  className,
  ariaLabel = "Plugin panels",
  compactAt = "narrow",
  controls = "compact"
}: {
  items: PluginPanelDockItem[];
  className?: string;
  ariaLabel?: string;
  compactAt?: "narrow" | "medium" | "wide";
  controls?: "compact" | "always" | "compact-or-hidden";
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [openId, setOpenId] = useState<string | undefined>();
  const compact = useDockCompact(rootRef, compactAt);

  useOutsidePointerDismiss(Boolean(openId), rootRef, () => {
    items.find((item) => item.id === openId)?.onOpenChange?.(false);
    setOpenId(undefined);
  });

  return (
    <div ref={rootRef} className={["plugin-panel-dock", `compact-${compactAt}`, `controls-${controls}`, className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      {items.map((item, index) => {
        const visible = item.visible ?? true;
        const canToggleVisible = Boolean(item.onVisibleChange);
        const open = openId === item.id;
        const panelAvailable = compact || visible;
        const canChangeVisibility = canToggleVisible && !compact && controls !== "compact";
        const canHideFromButton = canChangeVisibility && controls === "always";
        const buttonLabel = compact ? item.label : visible
          ? canHideFromButton ? item.hideLabel ?? `Hide ${item.label}` : item.label
          : item.showLabel ?? `Show ${item.label}`;
        const buttonPressed = canHideFromButton ? visible : open;
        const itemStyle = { "--plugin-panel-dock-offset": pluginPanelDockOffset(index) } as CSSProperties;
        function toggleOpen() {
          if (compact) {
            const previousItem = items.find((candidate) => candidate.id === openId);
            if (open) {
              item.onOpenChange?.(false);
              setOpenId(undefined);
            } else {
              previousItem?.onOpenChange?.(false);
              item.onOpenChange?.(true);
              setOpenId(item.id);
            }
            return;
          }
          if (!visible) {
            item.onVisibleChange?.(true);
            setOpenId(undefined);
            return;
          }
          if (canHideFromButton) {
            item.onVisibleChange?.(false);
            item.onOpenChange?.(false);
            setOpenId(undefined);
            return;
          }
          item.onOpenChange?.(!open);
          setOpenId(open ? undefined : item.id);
        }
        function hidePanel() {
          item.onVisibleChange?.(false);
          item.onOpenChange?.(false);
          setOpenId(undefined);
        }
        return (
          <div key={item.id} className={`plugin-panel-dock-item${open ? " open" : ""}${visible ? "" : " hidden"}`} style={itemStyle}>
            <ControlButton
              type="button"
              className="plugin-panel-dock-button compact-icon-button"
              size="compact"
              iconOnly
              pressed={buttonPressed}
              aria-expanded={panelAvailable ? open : false}
              aria-label={buttonLabel}
              title={buttonLabel}
              onClick={toggleOpen}
            >
              {item.icon}
            </ControlButton>
            {panelAvailable ? (
              <div className="plugin-panel-dock-panel" role="region" aria-label={item.label}>
                {canChangeVisibility ? (
                  <div className="plugin-panel-dock-panel-heading">
                    <span>{item.label}</span>
                    <ControlButton type="button" className="compact-icon-button" size="compact" iconOnly onClick={hidePanel} aria-label={item.hideLabel ?? `Hide ${item.label}`} title={item.hideLabel ?? `Hide ${item.label}`}>
                      <EyeOff size={14} />
                    </ControlButton>
                  </div>
                ) : null}
                {item.children}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function pluginPanelDockOffset(index: number): string {
  if (index <= 0) {
    return "0px";
  }
  return `calc(${Array.from({ length: index }, () => "var(--plugin-panel-dock-button-size)").join(" + ")})`;
}

function useDockCompact(rootRef: RefObject<HTMLDivElement | null>, compactAt: "narrow" | "medium" | "wide"): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const target = rootRef.current?.parentElement;
    if (!target || typeof ResizeObserver === "undefined") {
      return;
    }
    const threshold = compactAt === "wide" ? 1180 : compactAt === "medium" ? 960 : 760;
    const update = () => setCompact(target.getBoundingClientRect().width <= threshold);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => observer.disconnect();
  }, [compactAt, rootRef]);
  return compact;
}
