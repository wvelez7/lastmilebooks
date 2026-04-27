import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70 bg-card">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div className="space-y-3">
            <Logo />
            <p className="max-w-md text-sm text-muted-foreground">
              Free book donation pickups across Murrieta, Menifee, Temecula,
              and surrounding areas. We give donated books a second life so
              they end up somewhere they'll be read again.
            </p>
          </div>
          <div className="text-sm text-muted-foreground">
            <a
              href="mailto:thelastmilebooks@gmail.com"
              className="hover:text-foreground"
              data-testid="link-email"
            >
              thelastmilebooks@gmail.com
            </a>
          </div>
        </div>
        <div className="mt-8 flex items-center justify-between border-t border-border/70 pt-6 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Last Mile Books</span>
          <span>Murrieta · Menifee · Temecula</span>
        </div>
      </div>
    </footer>
  );
}
