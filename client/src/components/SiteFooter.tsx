import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-border/70 bg-card">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          <div className="space-y-3">
            <Logo />
            <p className="max-w-md text-sm text-muted-foreground">
              Free book donation pickups across Murrieta, Menifee, Temecula,
              Palm Springs, and surrounding areas. We give donated books a
              second life so they end up somewhere they'll be read again.
            </p>
            <p className="text-sm text-muted-foreground">
              <a
                href="mailto:hello@lastmilebooks.com"
                className="hover:text-foreground"
                data-testid="link-email"
              >
                hello@lastmilebooks.com
              </a>
              {" · "}
              <a href="tel:+19512493215" className="hover:text-foreground">
                (951) 249-3215
              </a>
            </p>
          </div>

          <div className="text-sm">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-foreground">
              Service areas
            </h3>
            <ul className="space-y-2 text-muted-foreground">
              <li>
                <a
                  href="/book-donation-pickup-temecula.html"
                  className="hover:text-foreground"
                  data-testid="link-temecula"
                >
                  Temecula book donation pickup
                </a>
              </li>
              <li>
                <a
                  href="/book-donation-pickup-murrieta.html"
                  className="hover:text-foreground"
                  data-testid="link-murrieta"
                >
                  Murrieta book donation pickup
                </a>
              </li>
              <li>
                <a
                  href="/book-donation-pickup-menifee.html"
                  className="hover:text-foreground"
                  data-testid="link-menifee"
                >
                  Menifee book donation pickup
                </a>
              </li>
              <li>
                <a
                  href="/book-donation-pickup-palm-springs.html"
                  className="hover:text-foreground"
                  data-testid="link-palm-springs"
                >
                  Palm Springs book donation pickup
                </a>
              </li>
            </ul>
          </div>

          <div className="text-sm">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-foreground">
              Services
            </h3>
            <ul className="space-y-2 text-muted-foreground">
              <li>
                <a
                  href="/estate-library-cleanout.html"
                  className="hover:text-foreground"
                  data-testid="link-estate"
                >
                  Estate library cleanouts
                </a>
              </li>
              <li>
                <a
                  href="/#schedule"
                  className="hover:text-foreground"
                  data-testid="link-schedule"
                >
                  Schedule a pickup
                </a>
              </li>
              <li>
                <a
                  href="/#faq"
                  className="hover:text-foreground"
                  data-testid="link-faq-footer"
                >
                  FAQ
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 flex items-center justify-between border-t border-border/70 pt-6 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Last Mile Books</span>
          <span>Temecula · Murrieta · Menifee · Palm Springs</span>
        </div>
      </div>
    </footer>
  );
}
