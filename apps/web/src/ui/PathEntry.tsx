import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { PathOption } from "@cloudx/shared";

import { getPathOptions } from "../api.js";
import { OUTSIDE_POINTER_INSIDE_ATTRIBUTE } from "./outsidePointer.js";

export function PathEntry({
  inputId,
  value,
  onChange,
  placeholder = "~, ~/project, or relative/path",
  ariaLabel,
  disabled
}: {
  inputId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<PathOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [listStyle, setListStyle] = useState<CSSProperties | undefined>();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionsId = `${inputId}-options`;

  useEffect(() => {
    if (!open) {
      return;
    }
    function updatePosition() {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) {
        setListStyle(undefined);
        return;
      }
      setListStyle({
        position: "fixed",
        top: rect.bottom + 7,
        right: "auto",
        left: rect.left,
        width: rect.width,
        zIndex: 1000
      });
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || disabled) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadOptions();
    }, 120);

    async function loadOptions() {
      try {
        const nextOptions = await getPathOptions(value);
        if (cancelled) return;
        setOptions(nextOptions);
        setHighlighted(0);
        setError(undefined);
      } catch (err) {
        if (cancelled) return;
        setOptions([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [disabled, open, value]);

  function choose(option: PathOption) {
    onChange(option.value);
    setOpen(false);
    setHighlighted(0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!open || options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[highlighted];
      if (option) {
        choose(option);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="path-autocomplete">
      <input
        ref={inputRef}
        id={inputId}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 100)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={optionsId}
        aria-expanded={open}
        disabled={disabled}
      />
      {open && listStyle ? createPortal(
        <div id={optionsId} className="path-options" role="listbox" style={listStyle} {...{ [OUTSIDE_POINTER_INSIDE_ATTRIBUTE]: "true" }}>
          {options.length > 0 ? (
            options.map((option, index) => (
              <button
                key={`${option.kind}:${option.value}`}
                type="button"
                className={`path-option ${index === highlighted ? "active" : ""}`}
                role="option"
                aria-selected={index === highlighted}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(option)}
              >
                <span>{option.label}</span>
                {option.detail ? <small>{option.detail}</small> : null}
              </button>
            ))
          ) : (
            <div className="path-options-empty">{error ?? "No matching directories."}</div>
          )}
        </div>,
        document.body
      ) : null}
    </div>
  );
}
