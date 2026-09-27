export interface LineItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export function subtotalCents(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

export function applyCoupon(subtotal: number, percentOff: number): number {
  return Math.round(subtotal * (1 - Math.min(Math.max(percentOff, 0), 100) / 100));
}

export function formatCents(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100);
}
