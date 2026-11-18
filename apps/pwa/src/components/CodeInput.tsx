import { useEffect, useRef, useState } from "react";

/**
 * Six-digit code entry.
 *
 * A single real <input> is stretched invisibly over six visual slots. That is
 * deliberate: six separate inputs break paste, break iOS one-time-code
 * autofill, and fight the keyboard. One input with `inputMode="numeric"` and
 * `autoComplete="one-time-code"` behaves correctly on both platforms, and the
 * slots are pure presentation.
 */
export function CodeInput({
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const digits = value.split("");

  return (
    <div
      className={`code-input ${focused ? "is-focused" : ""} ${disabled ? "is-disabled" : ""}`}
      onPointerDown={(event) => {
        // Tapping anywhere in the box focuses the real input.
        if (event.target !== inputRef.current) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <input
        ref={inputRef}
        className="code-input-native"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        // The spec name matters on iOS: `one-time-code` is what offers the
        // code straight from the notification/keyboard bar.
        name="otp"
        pattern="[0-9]*"
        maxLength={6}
        aria-label="Six digit sign-in code"
        spellCheck={false}
        autoCorrect="off"
      />
      <div className="code-slots" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => {
          const char = digits[index] ?? "";
          const isActive = focused && index === Math.min(value.length, 5);
          return (
            <div
              key={index}
              className={`code-slot ${char ? "is-filled" : ""} ${isActive ? "is-active" : ""}`}
            >
              {char || (isActive ? <span className="caret" /> : "")}
            </div>
          );
        })}
      </div>
    </div>
  );
}
