type Props = { className?: string };

export function Logo({ className = "h-8 w-auto" }: Props) {
  return (
    <div className={`flex items-center gap-2 ${className}`} data-testid="logo">
      <svg
        viewBox="0 0 32 32"
        className="h-8 w-8 text-primary"
        aria-hidden
      >
        <rect width="32" height="32" rx="6" fill="currentColor" />
        <path
          d="M8 9.5h7a3 3 0 0 1 3 3V24a2 2 0 0 0-2-2H8z"
          fill="none"
          stroke="hsl(var(--background))"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M24 9.5h-7a3 3 0 0 0-3 3V24a2 2 0 0 1 2-2h8z"
          fill="none"
          stroke="hsl(var(--background))"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="font-serif text-base font-semibold tracking-tight text-foreground">
        Last Mile Books
      </span>
    </div>
  );
}
