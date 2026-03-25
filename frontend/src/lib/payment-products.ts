export interface PaymentProduct {
  id: string;
  credits: number;
  amount: number;
  label: string;
  priceLabel: string;
}

export const PAYMENT_PRODUCTS: PaymentProduct[] = [
  { id: 'credit_50', credits: 50, amount: 3000, label: '50 크레딧', priceLabel: '3,000원' },
  { id: 'credit_150', credits: 150, amount: 8000, label: '150 크레딧', priceLabel: '8,000원' },
  { id: 'credit_300', credits: 300, amount: 14000, label: '300 크레딧', priceLabel: '14,000원' },
];

export function findProduct(productId: string): PaymentProduct | undefined {
  return PAYMENT_PRODUCTS.find((p) => p.id === productId);
}
