import { Link } from "wouter";
import { Logo } from "./Logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Menu } from "lucide-react";

function scrollTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
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
          <a
            href="/partners.html"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-partners-header"
          >
            Partners
          </a>
          <button
            onClick={() => scrollTo("faq")}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-faq"
          >
            FAQ
          </button>
        </nav>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => scrollTo("schedule")}
            size="sm"
            className="font-medium"
            data-testid="button-schedule"
          >
            Schedule a pickup
          </Button>

          {/* Phones: the nav links above are hidden, so offer them here */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 md:hidden"
                aria-label="Menu"
                data-testid="button-mobile-menu"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => scrollTo("how-it-works")}>
                How it works
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => scrollTo("about")}>
                About
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => scrollTo("faq")}>
                FAQ
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/estate-library-cleanout.html">Estate cleanouts</a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/partners.html">Partners</a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

