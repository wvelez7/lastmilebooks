import { isLowOnSupply, supplies, supplyHistory } from "@shared/schema";
import type { Supply, SupplyHistoryRow, UpsertSupply } from "@shared/schema";
import { asc, desc, eq, gt, inArray, isNotNull, sql, and } from "drizzle-orm";
import { db } from "../storage";
import { sendTeamAlert } from "../email";
import { inventoryStore } from "./store";

// How it works: stock goes down by hand or by used_per_order on each marketplace
// order. When a supply hits its reorder point the team gets one email with what
// to buy and where. Nothing is bought from here: after buying, "Mark ordered"
// stops the alerts and "Received" adds the delivery to stock.

export function listSupplies(): Supply[] {
  return db.select().from(supplies).orderBy(asc(supplies.name)).all();
}

function getSupply(id: number): Supply | undefined {
  return db.select().from(supplies).where(eq(supplies.id, id)).get();
}

// Writes a history row when the count actually moved. Callers read `before`
// and write the change with no await in between, so rows can't interleave.
function recordChange(before: number, after: Supply, reason: string): void {
  const change = after.quantity - before;
  if (change === 0) return;
  db.insert(supplyHistory)
    .values({ supplyId: after.id, supplyName: after.name, change, quantity: after.quantity, reason })
    .run();
}

export function listSupplyHistory(limit = 200): SupplyHistoryRow[] {
  return db.select().from(supplyHistory).orderBy(desc(supplyHistory.id)).limit(limit).all();
}

export function createSupply(data: UpsertSupply): Supply {
  const supply = db.insert(supplies).values(data).returning().get();
  recordChange(0, supply, "Added");
  return supply;
}

export function updateSupply(id: number, data: UpsertSupply): Supply | undefined {
  const before = getSupply(id);
  if (!before) return undefined;
  const supply = db
    .update(supplies)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(supplies.id, id))
    .returning()
    .get();
  if (supply) recordChange(before.quantity, supply, "Count edited");
  return supply;
}

export function deleteSupply(id: number): boolean {
  return db.delete(supplies).where(eq(supplies.id, id)).run().changes > 0;
}

// Atomic so a sale and a hand count can't both read the old quantity.
export function adjustSupply(id: number, by: number, reason = "Changed by hand"): Supply | undefined {
  const before = getSupply(id);
  if (!before) return undefined;
  const supply = db
    .update(supplies)
    .set({
      quantity: sql`max(0, ${supplies.quantity} + ${by})`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(supplies.id, id))
    .returning()
    .get();
  if (supply) recordChange(before.quantity, supply, reason);
  return supply;
}

export function markOrdered(id: number): Supply | undefined {
  const now = new Date().toISOString();
  return db
    .update(supplies)
    .set({ orderedQuantity: sql`${supplies.reorderQuantity}`, orderedAt: now, updatedAt: now })
    .where(eq(supplies.id, id))
    .returning()
    .get();
}

export function cancelOrder(id: number): Supply | undefined {
  return db
    .update(supplies)
    .set({ orderedQuantity: null, orderedAt: null, updatedAt: new Date().toISOString() })
    .where(eq(supplies.id, id))
    .returning()
    .get();
}

// Only matches while an order is open, so a double tap can't add it twice.
export function markReceived(id: number): Supply | undefined {
  const before = getSupply(id);
  if (!before) return undefined;
  const supply = db
    .update(supplies)
    .set({
      quantity: sql`${supplies.quantity} + ${supplies.orderedQuantity}`,
      orderedQuantity: null,
      orderedAt: null,
      alertedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(supplies.id, id), isNotNull(supplies.orderedQuantity)))
    .returning()
    .get();
  if (supply) recordChange(before.quantity, supply, "Received order");
  return supply;
}

// One email covering everything newly low. Clears the mark first so a supply
// that was restocked can alert again the next time it runs low.
export async function alertLowSupplies(): Promise<void> {
  db.update(supplies).set({ alertedAt: null }).where(gt(supplies.quantity, supplies.reorderAt)).run();

  const due = listSupplies().filter((s) => isLowOnSupply(s) && !s.orderedAt && !s.alertedAt);
  if (due.length === 0) return;
  const ids = due.map((s) => s.id);

  // Marked before sending so overlapping sales can't send it twice.
  db.update(supplies).set({ alertedAt: new Date().toISOString() }).where(inArray(supplies.id, ids)).run();

  const lines = due.map((s) => {
    const cost = s.unitCost === null ? "" : ` (about $${(s.unitCost * s.reorderQuantity).toFixed(2)})`;
    const from = s.supplier ? ` from ${s.supplier}` : "";
    return [`${s.name}: ${s.quantity} left. Reorder ${s.reorderQuantity}${from}${cost}`, s.productUrl]
      .filter(Boolean)
      .join("\n");
  });
  const result = await sendTeamAlert(
    due.length === 1 ? `Low on ${due[0].name}` : `Low on ${due.length} shipping supplies`,
    `${lines.join("\n\n")}\n\nAfter buying, tap Mark ordered at https://lastmilebooks.com/#/supplies`,
  );

  if (result.ok) {
    inventoryStore.log("info", `Low supply email sent: ${due.map((s) => s.name).join(", ")}`);
  } else {
    // Try again on the next stock change.
    db.update(supplies).set({ alertedAt: null }).where(inArray(supplies.id, ids)).run();
    inventoryStore.log("warn", `Low supply email not sent (${result.status}): ${due.map((s) => s.name).join(", ")}`);
  }
}

const TURN_KEY = "supplies_last_turn"; // id of the supply the last order used

const MARKETPLACE_NAMES: Record<string, string> = { ebay: "eBay", whatnot: "Whatnot", amazon: "Amazon" };

// "ebay:12-34567-89" -> "eBay order 12-34567-89"
function orderReason(orderKey: string): string {
  const split = orderKey.indexOf(":");
  const platform = orderKey.slice(0, split);
  return `${MARKETPLACE_NAMES[platform] ?? platform} order ${orderKey.slice(split + 1)}`;
}

// `orderKey` is "<platform>:<order id>". Claimed once per order, not per line,
// because several books in one order share a package.
export async function useSuppliesForOrder(orderKey: string): Promise<void> {
  if (!inventoryStore.claimSale(`supplies:${orderKey}`)) return;
  const reason = orderReason(orderKey);
  const used = listSupplies().filter((s) => s.usedPerOrder > 0);
  for (const supply of used) {
    if (!supply.takesTurns) adjustSupply(supply.id, -supply.usedPerOrder, reason);
  }
  // Supplies that take turns: this order uses the one after the last one used.
  // No await between reading and saving the turn, so overlapping orders can't
  // both pick the same one.
  const turns = used.filter((s) => s.takesTurns).sort((a, b) => a.id - b.id);
  if (turns.length > 0) {
    const last = Number(inventoryStore.getState(TURN_KEY) ?? 0);
    const next = turns.find((s) => s.id > last) ?? turns[0];
    adjustSupply(next.id, -next.usedPerOrder, reason);
    inventoryStore.setState(TURN_KEY, String(next.id));
  }
  await alertLowSupplies();
}
