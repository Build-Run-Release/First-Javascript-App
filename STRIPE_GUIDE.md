# Stripe Integration Guide for University of Ibadan Ecommerce

This guide explains how to fully implement the payment system so that:
1.  **Platform Owner (You)**: Receives the 10% service fee automatically.
2.  **Sellers**: Receive their 90% share directly to their bank accounts.
3.  **Buyers**: Pay securely using their cards.

## Core Concept: Stripe Connect

To split payments between you (the platform) and the sellers, you must use **Stripe Connect**. Standard Stripe accounts only allow you to collect money for yourself. Stripe Connect allows you to act as a marketplace.

### 1. Platform Setup (Your Details)

1.  Go to [dashboard.stripe.com](https://dashboard.stripe.com) and sign up.
2.  Navigate to **Connect** settings to enable marketplace features.
3.  Go to **Developers > API keys**.
4.  Copy your `Publishable Key` and `Secret Key`.
5.  Add these to your `.env` file or environment variables (never commit them to GitHub!).

### 2. Seller Onboarding (Adding Seller Payment Details)

Sellers do not just "type in an account number". To ensure you are compliant with financial regulations (KYC), sellers must create or link a **Stripe Express** or **Stripe Standard** account.

**The Flow:**
1.  Seller logs in to your dashboard.
2.  Seller clicks **"Connect with Stripe"**.
3.  They are redirected to Stripe's hosted onboarding page.
4.  They enter their bank details and identity info securely on Stripe.
5.  Stripe redirects them back to your site with an `authorization_code`.
6.  Your server swaps this code for a `stripe_user_id` (the Connected Account ID) and saves it to the seller's record in your database.

**In the Code:**
We have added a `/onboard-seller` skeleton in `server.js` to handle this.

### 3. Buyer Payment & Automatic Fee Deduction

When a buyer purchases an item, you will use the **PaymentIntents API** with specific parameters to handle the split.

**The Formula:**
*   **Total Charge:** $100.00
*   **Service Fee (10%):** $10.00 (Your platform revenue)
*   **Seller Amount:** $90.00

**The Code Logic:**

```javascript
const paymentIntent = await stripe.paymentIntents.create({
  amount: 10000, // $100.00 in cents
  currency: 'usd',
  payment_method_types: ['card'],
  application_fee_amount: 1000, // $10.00 fee goes to YOU
  transfer_data: {
    destination: 'acct_123456789', // The SELLER'S connected account ID
  },
});
```

*   `application_fee_amount`: This amount stays in your Stripe Platform account.
*   `transfer_data.destination`: The remaining amount ($90.00) is automatically transferred to the seller's Stripe account.

### 4. Buyer Payment Methods (Adding Cards)

Unlike sellers, buyers do not typically "onboard" ahead of time. Instead, they add their payment details **during checkout**.

**The Flow:**
1.  **Checkout Page**: The buyer enters their card details into the **Stripe Element** (the secure input field we added to `checkout.ejs`).
2.  **Saving Cards**: If you want buyers to save their card for future use:
    *   Create a **Stripe Customer** object for the buyer (`stripe.customers.create`).
    *   Save the `customer_id` in your `users` database table.
    *   When processing the payment, attach the `payment_method` to the Customer.
    *   Next time, you can list the customer's saved cards so they don't have to type it again.

**In the Code:**
*   **Checkout UI**: We use Stripe Elements to securely collect card info.
*   **Backend**: We have added comments in the `/charge` route explaining where to create the Customer and save the card.

### Summary of Steps to Go Live

1.  **Register Platform**: Get your Stripe keys.
2.  **Update `server.js`**: Replace placeholders with real keys.
3.  **Implement Onboarding**: Uncomment the `/onboard-seller` route logic and save `stripe_account_id` to your `users` table.
4.  **Implement Checkout**: Use the `application_fee_amount` logic in the `/charge` route using the seller's saved `stripe_account_id`.
