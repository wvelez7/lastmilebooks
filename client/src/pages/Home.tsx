import { Button } from "@/components/ui/button";
import { PickupForm } from "@/components/PickupForm";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import {
  BookOpen,
  Truck,
  HeartHandshake,
  ShieldCheck,
  Sparkles,
  Recycle,
} from "lucide-react";

import HERO_PHOTO from "@/assets/photos/hero.jpg";
import BOOKS_STACK_PHOTO from "@/assets/photos/books-stack.jpg";
import BOOKSHELF_PHOTO from "@/assets/photos/bookshelf.jpg";
import DONATION_BOX_PHOTO from "@/assets/photos/donation-box.jpg";
import OPEN_BOOK_PHOTO from "@/assets/photos/open-book.jpg";

function scrollTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* HERO */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-secondary/60 to-background" />
        <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
          <div className="grid items-center gap-12 md:grid-cols-2">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-primary">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Murrieta · Menifee · Temecula · Palm Springs
              </div>
              <h1 className="mt-6 font-serif text-4xl font-semibold leading-[1.1] tracking-tight text-foreground sm:text-5xl md:text-6xl">
                Give your books a&nbsp;second life.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
                Last Mile Books picks up donated books — for free — and gives
                them a second life. We come to you, load the books, and make
                sure they end up somewhere they'll be read again.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button
                  size="lg"
                  onClick={() => scrollTo("schedule")}
                  data-testid="button-hero-schedule"
                >
                  Schedule a free pickup
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => scrollTo("how-it-works")}
                  data-testid="button-hero-how"
                >
                  See how it works
                </Button>
              </div>
              <p className="mt-5 text-sm text-muted-foreground">
                One-box minimum · Estate cleanouts welcome · Same-week pickups
                available
              </p>
            </div>

            {/* Hero photo */}
            <div className="relative">
              <div className="relative aspect-[4/5] overflow-hidden rounded-3xl border border-border shadow-lg md:aspect-[5/6]">
                <img
                  src={HERO_PHOTO}
                  alt="A long warm-lit row of bookshelves stretching into the distance"
                  className="h-full w-full object-cover"
                  loading="eager"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-foreground/30 via-transparent to-transparent" />
              </div>
              <div className="absolute -bottom-5 -left-5 hidden rounded-2xl border border-border bg-card px-5 py-4 shadow-md md:block">
                <div className="text-xs font-semibold uppercase tracking-widest text-primary">
                  Free pickup
                </div>
                <div className="mt-1 font-serif text-lg font-semibold text-foreground">
                  We come to you.
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" className="border-t border-border/70 bg-card">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              How it works
            </p>
            <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
              Four steps. We do all the lifting.
            </h2>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                n: "01",
                title: "Tell us about the books",
                body: "Fill out the pickup form below — name, address, an estimate of how many boxes, and a date that works for you.",
              },
              {
                n: "02",
                title: "We confirm a pickup",
                body: "A team member responds within one business day with a confirmed window. No phone tag, no hidden fees.",
              },
              {
                n: "03",
                title: "We do the pickup",
                body: "We arrive on the agreed day with our own boxes and vehicle. Books are loaded and you get a receipt for your records.",
              },
              {
                n: "04",
                title: "Books get a second life",
                body: "We sort the books and find new homes for them — locally where we can, and responsibly recycled when we can't.",
              },
            ].map((s) => (
              <div
                key={s.n}
                className="relative rounded-2xl border border-border bg-background p-6"
              >
                <div className="font-serif text-sm font-semibold text-accent">
                  {s.n}
                </div>
                <h3 className="mt-3 text-lg font-semibold text-foreground">
                  {s.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WHAT WE TAKE */}
      <section className="border-t border-border/70">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-12 md:grid-cols-2 md:gap-16">
            {/* Photo column */}
            <div className="relative">
              <div className="aspect-[4/5] overflow-hidden rounded-3xl border border-border shadow-md">
                <img
                  src={DONATION_BOX_PHOTO}
                  alt="A close-up row of well-loved used books standing upright"
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
            </div>

            {/* Copy column */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                What we take
              </p>
              <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
                Almost any book in any condition.
              </h2>
              <p className="mt-5 text-base leading-relaxed text-muted-foreground">
                Hardcovers, paperbacks, textbooks, cookbooks, children's
                books, art books, classics, popular fiction — all welcome.
                Whatever we can't pass along to a new reader, we recycle
                responsibly.
              </p>
              <div className="mt-7 flex flex-wrap gap-2 text-sm">
                {[
                  "Fiction",
                  "Non-fiction",
                  "Children's",
                  "Textbooks",
                  "Cookbooks",
                  "Art & design",
                  "Reference",
                  "Estate libraries",
                ].map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border bg-card px-3 py-1 text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-10 grid gap-4 sm:grid-cols-2">
                {[
                  {
                    Icon: Truck,
                    title: "Free pickup",
                    body: "We come to you across Murrieta, Menifee, Temecula, Palm Springs, and surrounding areas.",
                  },
                  {
                    Icon: BookOpen,
                    title: "One-box minimum",
                    body: "From a single box to an entire estate library — if you've got a box, we'll come.",
                  },
                  {
                    Icon: Recycle,
                    title: "Hand-sorted with care",
                    body: "Every donation is sorted by hand so each book has the best chance of finding a new reader.",
                  },
                  {
                    Icon: HeartHandshake,
                    title: "Local & friendly",
                    body: "A small Riverside-County team that values books and the people donating them.",
                  },
                ].map((b) => (
                  <div
                    key={b.title}
                    className="rounded-2xl border border-border bg-card p-5"
                  >
                    <b.Icon className="h-5 w-5 text-primary" />
                    <div className="mt-3 font-semibold text-foreground">
                      {b.title}
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {b.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* IMAGE BAND — visual breath between sections */}
      <section className="border-y border-border/70">
        <div className="relative h-64 w-full overflow-hidden md:h-80">
          <img
            src={BOOKS_STACK_PHOTO}
            alt="A curving wall of colorful book spines on warm wooden shelves"
            className="h-full w-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-foreground/30" />
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <p className="max-w-2xl text-center font-serif text-2xl font-semibold leading-snug text-background md:text-3xl">
              "Every book deserves a next reader."
            </p>
          </div>
        </div>
      </section>

      {/* SCHEDULE / FORM */}
      <section
        id="schedule"
        className="border-t border-border/70 bg-secondary/40"
      >
        <div className="mx-auto max-w-3xl px-6 py-20">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              Schedule a pickup
            </p>
            <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
              Tell us where to come.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground">
              Free pickup across Murrieta, Menifee, Temecula, Palm Springs, and surrounding
              areas. One-box minimum. We respond within one business day.
            </p>
          </div>
          <div className="mt-10">
            <PickupForm />
          </div>
        </div>
      </section>

      {/* ABOUT */}
      <section id="about" className="border-t border-border/70">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid items-start gap-12 md:grid-cols-2 md:gap-16">
            <div className="md:sticky md:top-24">
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                About
              </p>
              <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
                Every book deserves a next reader.
              </h2>
              <div className="mt-8 aspect-[4/3] overflow-hidden rounded-2xl border border-border shadow-sm">
                <img
                  src={BOOKSHELF_PHOTO}
                  alt="A floor-to-ceiling wall of well-organized books"
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
            </div>
            <div className="space-y-5 text-base leading-relaxed text-muted-foreground">
              <p>
                Last Mile Books was founded on a simple idea: most donated
                books still have a reader out there somewhere — they just need
                help getting found. We are a local team that handles the
                logistics so the books can keep working.
              </p>
              <p>
                We sort books by hand and do our best to give every one of
                them a second life. Whatever can't be passed along is
                recycled responsibly. Nothing wasted, nothing thrown away.
              </p>
              <div className="grid grid-cols-2 gap-6 pt-4">
                <Stat
                  Icon={ShieldCheck}
                  label="Local & trusted"
                  body="Run by a small team in Riverside County."
                />
                <Stat
                  Icon={Sparkles}
                  label="Hand-sorted with care"
                  body="Every book given a second chance with a new reader."
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-border/70 bg-card">
        <div className="mx-auto max-w-3xl px-6 py-20">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              FAQ
            </p>
            <h2 className="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
              Common questions.
            </h2>
          </div>
          <div className="mt-10 divide-y divide-border rounded-2xl border border-border bg-background">
            {[
              {
                q: "Is the pickup really free?",
                a: "Yes. We don't charge for pickups, and donors don't pay anything. We just ask for a one-box minimum so the trip makes sense.",
              },
              {
                q: "What's the minimum to schedule a pickup?",
                a: "One full box. We can't make a special trip for just a few loose books, but a single box of any size is plenty — and there's no maximum.",
              },
              {
                q: "Where do you pick up?",
                a: "We currently service Murrieta, Menifee, Temecula, Palm Springs, and surrounding areas in Riverside County. If you're slightly outside that radius, contact us — we'll often still come.",
              },
              {
                q: "What kinds of books do you take?",
                a: "Just about everything: fiction, non-fiction, textbooks, cookbooks, children's books, hardcovers, paperbacks. We accept books in just about any readable condition.",
              },
              {
                q: "Can you provide a donation receipt?",
                a: "Yes — when we pick up, we leave a written receipt with the date and an item count for your records.",
              },
              {
                q: "How quickly can you come out?",
                a: "Same-week pickups are usually available. We confirm your preferred date within one business day of your request.",
              },
              {
                q: "Do you really pick up books for free in Murrieta?",
                a: "Yes — pickups are completely free across Murrieta and surrounding areas. We just ask for a one-box minimum so the trip makes sense. There is no maximum and no hidden fee.",
              },
              {
                q: "Can you handle an estate library with 1,000+ books in Temecula?",
                a: "Absolutely. Estate libraries are our specialty in Temecula and the surrounding Riverside County area. We have handled jobs from a single box up to thousands of books. We do a walkthrough, sort everything by hand, and leave you with a written receipt for the full count.",
              },
              {
                q: "How fast can you come out to Menifee for a pickup?",
                a: "Same-week pickups in Menifee are usually available. After you submit a request, we confirm your preferred date within one business day.",
              },
              {
                q: "Do you pick up books in Palm Springs?",
                a: "Yes. We service Palm Springs and the surrounding Coachella Valley for book donation pickups. Because it is a longer drive from our base in Temecula, Palm Springs pickups are typically scheduled for a specific weekly route — submit a request and we will give you the next available window.",
              },
              {
                q: "What kinds of books do you NOT accept?",
                a: "Almost nothing is off-limits. Fiction, non-fiction, textbooks, cookbooks, children's books, hardcovers, paperbacks, encyclopedias, reference books, religious books, art books — all welcome. The only books we cannot accept are those that are wet, moldy, or actively falling apart.",
              },
            ].map((item) => (
              <details
                key={item.q}
                className="group px-6 py-5"
                data-testid={`faq-${item.q.slice(0, 20)}`}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-foreground">
                  <span>{item.q}</span>
                  <span className="text-muted-foreground transition group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA STRIP */}
      <section className="relative overflow-hidden border-t border-border/70">
        <div className="absolute inset-0">
          <img
            src={OPEN_BOOK_PHOTO}
            alt=""
            aria-hidden
            className="h-full w-full object-cover"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-primary/85" />
        </div>
        <div className="relative mx-auto max-w-3xl px-6 py-16 text-center">
          <h2 className="font-serif text-3xl font-semibold tracking-tight text-primary-foreground md:text-4xl">
            Ready to clear some shelves?
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-primary-foreground/90">
            One box or one thousand — let's give them a second life.
          </p>
          <div className="mt-8">
            <Button
              size="lg"
              variant="secondary"
              onClick={() => scrollTo("schedule")}
              data-testid="button-cta-schedule"
            >
              Schedule a pickup
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function Stat({
  Icon,
  label,
  body,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  body: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-foreground">
        <Icon className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
