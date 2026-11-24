import { Link, useLocation } from "wouter";
import { BadgeDollarSign, Boxes, LayoutDashboard, Package, RefreshCcw, ScanBarcode, Tags } from "lucide-react";

// Menu linking the admin pages to each other, shown at the top of each one.
// The admin key is shared, so moving between them doesn't ask for it again.
const PAGES = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/scan", label: "Scanner", icon: ScanBarcode },
  { href: "/inventory", label: "Inventory", icon: Boxes },
  { href: "/profit", label: "Profit", icon: BadgeDollarSign },
  { href: "/repricer", label: "Repricer", icon: Tags },
  { href: "/returns", label: "Returns", icon: RefreshCcw },
  { href: "/supplies", label: "Supplies", icon: Package },
];

export default function AdminNav() {
  const [location] = useLocation();
  return (
    <nav aria-label="Admin pages" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <ul className="flex w-max gap-2">
        {PAGES.map(({ href, label, icon: Icon }) => {
          const current = location === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  current
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
