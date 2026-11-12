import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import {
  insertPickupRequestSchema,
  PICKUP_WEEKDAYS,
  type InsertPickupRequest,
} from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, ImagePlus, X } from "lucide-react";

const BOX_OPTIONS = [
  "1–2 boxes",
  "3–5 boxes",
  "6–10 boxes",
  "11–20 boxes",
  "21+ boxes",
];

const CITY_SUGGESTIONS = ["Temecula", "Murrieta", "Menifee", "Palm Springs"];

const PHOTO_MAX_SIDE = 1600;

// Shrink a phone photo to a JPEG data URL small enough to upload and email.
function resizePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable image"));
    };
    img.src = url;
  });
}

const WEEKS_AHEAD = 8;

// Upcoming Tuesdays and Wednesdays, starting tomorrow.
function upcomingPickupDates() {
  const dates: { value: string; label: string }[] = [];
  const d = new Date();
  for (let i = 1; i <= WEEKS_AHEAD * 7; i++) {
    d.setDate(d.getDate() + 1);
    if (!PICKUP_WEEKDAYS.includes(d.getDay())) continue;
    const value = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
    const label = d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    dates.push({ value, label });
  }
  return dates;
}

export function PickupForm() {
  const [submitted, setSubmitted] = useState(false);
  const [pickupDates] = useState(upcomingPickupDates);

  const form = useForm<InsertPickupRequest>({
    resolver: zodResolver(insertPickupRequestSchema),
    defaultValues: {
      fullName: "",
      email: "",
      phone: "",
      pickupAddress: "",
      city: "",
      numberOfBoxes: "",
      preferredDate: "",
      notes: "",
      photo: null,
    },
  });
  const [photoError, setPhotoError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (data: InsertPickupRequest) => {
      return apiRequest("POST", "/api/pickup-requests", data);
    },
    onSuccess: () => {
      setSubmitted(true);
      form.reset();
    },
  });

  if (submitted) {
    return (
      <div
        className="rounded-2xl border border-border bg-card p-8 text-center md:p-12"
        data-testid="status-submitted"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <h3 className="mt-5 font-serif text-2xl font-semibold text-foreground">
          Thanks — we'll be in touch.
        </h3>
        <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
          Your pickup request was received. A team member will reach out within
          one business day to confirm the date and any details.
        </p>
        <Button
          variant="outline"
          className="mt-6"
          onClick={() => setSubmitted(false)}
          data-testid="button-submit-another"
        >
          Submit another request
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((data) => mutation.mutate(data))}
        className="space-y-5 rounded-2xl border border-border bg-card p-6 md:p-8"
        data-testid="form-pickup"
      >
        <div className="grid gap-5 md:grid-cols-2">
          <FormField
            control={form.control}
            name="fullName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Jane Doe"
                    autoComplete="name"
                    {...field}
                    data-testid="input-full-name"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    placeholder="jane@example.com"
                    autoComplete="email"
                    {...field}
                    data-testid="input-email"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    placeholder="(951) 555-0100"
                    autoComplete="tel"
                    {...field}
                    data-testid="input-phone"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>City</FormLabel>
                <FormControl>
                  <Input
                    placeholder="Temecula, Murrieta, Menifee, Palm Springs…"
                    autoComplete="address-level2"
                    list="city-suggestions"
                    {...field}
                    data-testid="input-city"
                  />
                </FormControl>
                <datalist id="city-suggestions">
                  {CITY_SUGGESTIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="pickupAddress"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Pickup address</FormLabel>
              <FormControl>
                <Input
                  placeholder="123 Jefferson Ave"
                  autoComplete="street-address"
                  {...field}
                  data-testid="input-pickup-address"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 md:grid-cols-2">
          <FormField
            control={form.control}
            name="numberOfBoxes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Approximate number of boxes</FormLabel>
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger data-testid="select-boxes">
                      <SelectValue placeholder="Pick a range" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {BOX_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="preferredDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Preferred pickup date</FormLabel>
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                >
                  <FormControl>
                    <SelectTrigger data-testid="input-preferred-date">
                      <SelectValue placeholder="Pick a Tuesday or Wednesday" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {pickupDates.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Pickups run Tuesdays and Wednesdays.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (optional)</FormLabel>
              <FormControl>
                <Textarea
                  rows={4}
                  placeholder="Anything we should know? Gate codes, parking, types of books, time-of-day preference…"
                  {...field}
                  value={field.value || ""}
                  data-testid="input-notes"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="photo"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Photo of your donation (optional)</FormLabel>
              {field.value ? (
                <div className="space-y-2">
                  <img
                    src={field.value}
                    alt="Your donation"
                    className="max-h-48 rounded-md border border-border"
                    data-testid="img-photo-preview"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => field.onChange(null)}
                    data-testid="button-remove-photo"
                  >
                    <X className="mr-1 h-4 w-4" />
                    Remove photo
                  </Button>
                </div>
              ) : (
                <FormControl>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground hover:bg-muted/40">
                    <ImagePlus className="h-5 w-5" />
                    <span>Add a photo of your books or boxes</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      data-testid="input-photo"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        setPhotoError(null);
                        try {
                          field.onChange(await resizePhoto(file));
                        } catch {
                          setPhotoError(
                            "We couldn't read that photo. Please try a JPG or PNG."
                          );
                        }
                      }}
                    />
                  </label>
                </FormControl>
              )}
              <p className="text-xs text-muted-foreground">
                Helps us bring the right vehicle. Not required.
              </p>
              {photoError && (
                <p className="text-sm font-medium text-destructive">
                  {photoError}
                </p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {mutation.isError && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            data-testid="status-error"
          >
            Something went wrong submitting the form. Please try again or
            email{" "}
            <a className="underline" href="mailto:thelastmilebooks@gmail.com">
              thelastmilebooks@gmail.com
            </a>
            .
          </div>
        )}

        <div className="flex flex-col items-start justify-between gap-4 pt-2 sm:flex-row sm:items-center">
          <p className="text-xs text-muted-foreground">
            We typically respond within one business day.
          </p>
          <Button
            type="submit"
            size="lg"
            disabled={mutation.isPending}
            className="w-full sm:w-auto"
            data-testid="button-submit"
          >
            {mutation.isPending ? "Sending…" : "Request pickup"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
