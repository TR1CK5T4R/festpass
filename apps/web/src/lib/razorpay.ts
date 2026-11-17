import type { PaymentView } from '@festpass/shared';

// Razorpay Checkout: Razorpay's own payment window. Card and UPI details are typed into it and go
// straight to Razorpay; FestPass never sees them. Test mode only (rzp_test_ keys).

interface CheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface CheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
  theme: { color: string };
  handler: (response: CheckoutResponse) => void;
  modal: { ondismiss: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: CheckoutOptions) => { open(): void };
  }
}

let loading: Promise<void> | null = null;

/** Adds Razorpay's checkout.js to the page once; later calls reuse it. */
function loadScript(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load Razorpay. Check your connection and try again.'));
    };
    document.body.append(script);
  });
  return loading;
}

/**
 * Opens the payment window. `onSuccess` only means the browser *says* it worked: it is a hint for the
 * UI ("Confirming payment…"), never proof. The order becomes PAID only when Razorpay's signed webhook
 * reaches the API.
 */
export async function openCheckout(
  payment: PaymentView,
  handlers: { onSuccess: () => void; onDismiss: () => void },
) {
  await loadScript();
  const Checkout = window.Razorpay!;
  new Checkout({
    key: payment.keyId,
    order_id: payment.razorpayOrderId,
    amount: payment.amountPaise,
    currency: payment.currency,
    name: 'FestPass',
    description: payment.description,
    prefill: payment.prefill,
    theme: { color: '#3a54d6' },
    handler: () => handlers.onSuccess(),
    modal: { ondismiss: handlers.onDismiss },
  }).open();
}
