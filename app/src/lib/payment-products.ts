export interface PaymentProduct {
  id: string;
  credits: number;
  amount: number;
  label: string;
  priceLabel: string;
}

export const PAYMENT_PRODUCTS: PaymentProduct[] = [
  { id: 'credit_5', credits: 5, amount: 3000, label: '5 크레딧', priceLabel: '3,000원' },
  { id: 'credit_15', credits: 15, amount: 8000, label: '15 크레딧', priceLabel: '8,000원' },
  { id: 'credit_30', credits: 30, amount: 14000, label: '30 크레딧', priceLabel: '14,000원' },
];

export function findProduct(productId: string): PaymentProduct | undefined {
  return PAYMENT_PRODUCTS.find((p) => p.id === productId);
}
