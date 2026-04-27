import { Link } from "wouter";
import { Logo } from "./Logo";
import { Button } from "@/components/ui/button";

function scrollTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" data-testid="link-home">
          <a className="flex items-center" aria-label="Last Mile Books home">
            <Logo />
          </a>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          <button
            onClick={() => scrollTo("how-it-works")}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-how-it-works"
          >
            How it works
          </button>
          <button
            onClick={() => scrollTo("about")}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-about"
          >
            About
          </button>
          <button
            onClick={() => scrollTo("faq")}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-faq"
          >
            FAQ
          </button>
        </nav>

        <Button
          onClick={() => scrollTo("schedule")}
          size="sm"
          className="font-medium"
          data-testid="button-schedule"
        >
          Schedule a pickup
        </Button>
      </div>
    </header>
  );
}
