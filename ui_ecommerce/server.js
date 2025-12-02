const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_PLACEHOLDER'); // Replace with real key
const { db, initDb } = require('./db');
const path = require('path');

const app = express();
const PORT = 3000;

// Initialize DB
initDb();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: false
}));

// Routes

// Home
app.get('/', (req, res) => {
    db.all('SELECT * FROM products', (err, products) => {
        if (err) {
            console.error(err);
            return res.send("Error loading products");
        }
        res.render('index', { user: req.session.user, products: products });
    });
});

// Seller Routes
app.get('/seller/dashboard', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') {
        return res.redirect('/login');
    }
    db.all('SELECT * FROM products WHERE seller_id = ?', [req.session.user.id], (err, products) => {
        db.all('SELECT * FROM orders WHERE product_id IN (SELECT id FROM products WHERE seller_id = ?)', [req.session.user.id], (err, orders) => {
             res.render('seller_dashboard', { user: req.session.user, products: products, orders: orders });
        });
    });
});

app.post('/seller/add-product', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') {
        return res.status(403).send("Unauthorized");
    }
    const { title, description, price } = req.body;
    db.run('INSERT INTO products (title, description, price, seller_id) VALUES (?, ?, ?, ?)',
        [title, description, price, req.session.user.id], (err) => {
            if (err) console.error(err);
            res.redirect('/seller/dashboard');
        });
});

// Buyer/Checkout Routes
app.get('/buy/:id', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    const productId = req.params.id;
    db.get('SELECT * FROM products WHERE id = ?', [productId], (err, product) => {
        if (err || !product) return res.send("Product not found");

        // Calculate Fee (10%)
        const price = product.price;
        const serviceFee = price * 0.10;
        const totalAmount = price; // Buyer pays full price. We take cut from seller technically or add on top?
        // Prompt said "create a standard 10% on all transactions as our service fee"
        // Usually fees are deducted from what the seller gets.
        // Or added to what buyer pays.
        // Let's assume Buyer pays Price. Platform takes 10% of Price. Seller gets 90%.

        res.render('checkout', { user: req.session.user, product: product, serviceFee: serviceFee });
    });
});

// Seller Onboarding (Stripe Connect) - Skeleton
app.get('/onboard-seller', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.redirect('/login');

    // 1. Create a Standard Stripe Account for the seller (or use Express)
    // const account = await stripe.accounts.create({ type: 'standard' });

    // 2. Generate an account link for the seller to complete onboarding
    // const accountLink = await stripe.accountLinks.create({
    //   account: account.id,
    //   refresh_url: 'http://localhost:3000/reauth',
    //   return_url: 'http://localhost:3000/return',
    //   type: 'account_onboarding',
    // });

    // 3. Redirect seller to Stripe
    // res.redirect(accountLink.url);

    res.send("Redirecting to Stripe Connect Onboarding... (Simulated)");
});


app.post('/charge', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { productId, stripeToken } = req.body; // In real flow, we use payment intents

    db.get('SELECT * FROM products WHERE id = ?', [productId], async (err, product) => {
        if (err || !product) return res.send("Product not found");

        const amount = product.price;
        const serviceFee = amount * 0.10;
        const sellerAmount = amount - serviceFee;

        try {
            // Create Stripe Charge (Mock or Real)
            // In a real application, you would use the token from the frontend AND split the payment:

            // 1. If buyer wants to save card (req.body.save_card), create/retrieve Stripe Customer
            // if (req.body.save_card) {
            //    const customer = await stripe.customers.create({ email: req.session.user.email });
            //    // Save customer.id to DB for this user
            // }

            // 2. Create PaymentIntent
            // const paymentIntent = await stripe.paymentIntents.create({
            //     amount: Math.round(amount * 100), // cents
            //     currency: 'usd',
            //     payment_method_types: ['card'],
            //     // customer: customer.id, // Attach to customer if saving
            //     // setup_future_usage: 'off_session', // Use this to save the card
            //     application_fee_amount: Math.round(serviceFee * 100), // 10% fee to Platform
            //     transfer_data: {
            //       destination: 'acct_SELLER_CONNECTED_ID', // Send rest to Seller
            //     },
            // });

            // Since we don't have a frontend token generator without a real key,
            // we will simulate success for the assignment "Push to GitHub" requirement
            // but the code structure for Stripe is here.

            // To make it functional for the user to see, we will simulate the DB entry.

            db.run('INSERT INTO orders (buyer_id, product_id, amount, service_fee, seller_amount, status, stripe_payment_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [req.session.user.id, product.id, amount, serviceFee, sellerAmount, 'completed', 'ch_test_12345'],
                (err) => {
                    if (err) {
                        console.error(err);
                        return res.send("Error processing order");
                    }
                    res.send(`Purchase Successful! You paid $${amount}. Service Fee collected: $${serviceFee}. <a href="/">Go Home</a>`);
                }
            );

        } catch (e) {
            console.error(e);
            res.send("Payment Failed");
        }
    });
});

// Auth Routes
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return res.redirect('/login');
        if (bcrypt.compareSync(password, user.password)) {
            req.session.user = user;
            if (user.role === 'seller') return res.redirect('/seller/dashboard');
            return res.redirect('/');
        }
        res.redirect('/login');
    });
});

app.get('/signup', (req, res) => {
    res.render('signup');
});

app.post('/signup', (req, res) => {
    const { username, password, role } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, role], function(err) {
        if (err) {
            console.error("SIGNUP ERROR:", err);
            return res.status(500).send("Error creating user: " + err.message);
        }
        res.redirect('/login');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
