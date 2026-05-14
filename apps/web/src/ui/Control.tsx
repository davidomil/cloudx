import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

type ControlTone = "neutral" | "primary" | "danger";
type ControlSize = "normal" | "compact";

interface ControlClassOptions {
  className?: string;
  tone?: ControlTone;
  size?: ControlSize;
  iconOnly?: boolean;
  pressed?: boolean;
  selected?: boolean;
}

export type ControlButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & ControlClassOptions;
export type ControlLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & ControlClassOptions;

export function controlClassName({ className, tone = "neutral", size = "normal", iconOnly = false, pressed = false, selected = false }: ControlClassOptions = {}): string {
  return [
    "cx-button",
    `cx-button-${tone}`,
    size === "compact" ? "cx-button-compact" : "",
    iconOnly ? "cx-button-icon" : "",
    pressed ? "is-pressed" : "",
    selected ? "is-selected" : "",
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");
}

export function ControlButton({ className, tone, size, iconOnly, pressed, selected, type = "button", ...props }: ControlButtonProps) {
  return <button {...props} type={type} className={controlClassName({ className, tone, size, iconOnly, pressed, selected })} aria-pressed={pressed ?? props["aria-pressed"]} />;
}

export function ControlLink({ className, tone, size, iconOnly, pressed, selected, ...props }: ControlLinkProps) {
  return <a {...props} className={controlClassName({ className, tone, size, iconOnly, pressed, selected })} />;
}

export function Toolbar({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={["cx-toolbar", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}

export function SegmentedControl({ className, children, label }: { className?: string; children: ReactNode; label: string }) {
  return (
    <div className={["cx-segmented-control", className ?? ""].filter(Boolean).join(" ")} role="group" aria-label={label}>
      {children}
    </div>
  );
}
