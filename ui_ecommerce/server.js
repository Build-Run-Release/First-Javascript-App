require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const { body, validationResult } = require('express-validator');
const { db, initDb } = require('./db');
const path = require('path');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_placeholder';

const app = express();
const PORT = 3000;

// Initialize DB
initDb();

// Security Middleware: Helmet
app.use(helmet());

// Security Middleware: Rate Limiter
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false, // Set to true if using HTTPS
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Security Middleware: CSRF Protection
const csrfProtection = csurf({ cookie: true });
app.use(csrfProtection);

// Pass CSRF token to all views
app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken();
    next();
});

// Middleware to check blocked status
const checkBlocked = (req, res, next) => {
    if (req.session.user) {
        // Query DB for latest status
        db.get('SELECT is_blocked FROM users WHERE id = ?', [req.session.user.id], (err, user) => {
            if (err) return next(err);
            if (user && user.is_blocked) {
                req.session.destroy();
                return res.send("Your account has been blocked by the admin. Please contact support.");
            }
            next();
        });
    } else {
        next();
    }
};

app.use(checkBlocked);

// Routes

// Home
app.get('/', (req, res) => {
    db.all('SELECT * FROM products', (err, products) => {
        if (err) {
            console.error(err);
            return res.send("Error loading products");
        }
        // Fetch active ads that haven't expired
        const now = Date.now();
        db.all("SELECT * FROM ads WHERE status = 'active' AND expiry_date > ? ORDER BY id DESC LIMIT 3", [now], (err, ads) => {
             res.render('index', { user: req.session.user, products: products, ads: ads || [] });
        });
    });
});

// Admin Routes
app.get('/admin/dashboard', (req, res) => {
    // Simple admin check (in prod, use a role or specific user)
    // For now, anyone with role='admin'
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');

    db.all('SELECT * FROM users WHERE role = "seller"', (err, sellers) => {
        db.all('SELECT * FROM users WHERE role = "buyer"', (err, buyers) => {
            res.render('admin_dashboard', { user: req.session.user, sellers: sellers, buyers: buyers });
        });
    });
});

app.post('/admin/block/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send("Unauthorized");
    db.run('UPDATE users SET is_blocked = 1 WHERE id = ?', [req.params.id], (err) => {
        if (err) console.error(err);
        res.redirect('/admin/dashboard');
    });
});

app.post('/admin/unblock/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send("Unauthorized");
    db.run('UPDATE users SET is_blocked = 0 WHERE id = ?', [req.params.id], (err) => {
        if (err) console.error(err);
        res.redirect('/admin/dashboard');
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

// Buyer Routes
app.get('/buyer/dashboard', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'buyer') return res.redirect('/login');

    // Join with products table to get product names
    const query = `
        SELECT orders.*, products.title as product_title
        FROM orders
        JOIN products ON orders.product_id = products.id
        WHERE orders.buyer_id = ?
    `;

    db.all(query, [req.session.user.id], (err, orders) => {
        if (err) {
            console.error(err);
            return res.send("Error loading orders");
        }
        res.render('buyer_dashboard', { user: req.session.user, orders: orders });
    });
});

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

        res.render('checkout', { user: req.session.user, product: product, serviceFee: serviceFee });
    });
});

// Seller Onboarding (Paystack)
app.post('/seller/onboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.status(403).send("Unauthorized");
    const { bank_name, account_number, bank_code } = req.body;

    // Simulate Paystack Subaccount Creation
    // In production:
    // const response = await axios.post('https://api.paystack.co/subaccount', {
    //   business_name: req.session.user.username,
    //   settlement_bank: bank_code,
    //   account_number: account_number,
    //   percentage_charge: 0 // Platform takes fee via transaction charge, or using percentage_charge
    // }, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });

    const mockSubaccountCode = 'ACCT_' + Math.floor(Math.random() * 1000000);

    db.run('UPDATE users SET bank_name = ?, account_number = ?, paystack_subaccount_code = ? WHERE id = ?',
        [bank_name, account_number, mockSubaccountCode, req.session.user.id], (err) => {
            if (err) console.error(err);
            res.redirect('/seller/dashboard');
        });
});

app.post('/paystack/initialize', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { productId } = req.body;

    db.get('SELECT * FROM products WHERE id = ?', [productId], async (err, product) => {
        if (err || !product) return res.send("Product not found");

        const amount = product.price;

        // Retrieve seller
        db.get('SELECT * FROM users WHERE id = ?', [product.seller_id], async (err, seller) => {
            if (err || !seller) return res.send("Seller info not found");

            // Escrow Logic:
            // We do NOT split payment immediately. We charge the full amount to the Platform (Main Account).
            // Funds are held in the "Platform Wallet" (virtually) until delivery is confirmed.

            // For simulation:
            const authUrl = `/paystack/verify?reference=REF_${Math.floor(Math.random() * 1000000)}&productId=${product.id}&amount=${amount}`;

            res.redirect(authUrl);
        });
    });
});

app.get('/paystack/verify', (req, res) => {
    const { reference, productId, amount } = req.query;

    const productPrice = parseFloat(amount);
    const serviceFee = productPrice * 0.10;
    const sellerAmount = productPrice - serviceFee;

    // Status is 'paid', but funds are NOT yet released to seller wallet.
    // They are in Escrow.
    db.run('INSERT INTO orders (buyer_id, product_id, amount, service_fee, seller_amount, status, payment_reference, buyer_confirmed, seller_confirmed, escrow_released) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)',
        [req.session.user.id, productId, productPrice, serviceFee, sellerAmount, 'paid', reference],
        (err) => {
            if (err) {
                console.error(err);
                return res.send("Error processing order");
            }
            res.send(`Payment Successful! Funds held in Escrow until delivery is confirmed by both parties. <a href="/">Go Home</a>`);
        }
    );
});

// Confirmation & Escrow Release Routes
app.post('/order/:id/confirm/buyer', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    // Check if order belongs to user
    db.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.id, req.session.user.id], (err, order) => {
        if (err || !order) return res.send("Order not found or unauthorized");

        db.run('UPDATE orders SET buyer_confirmed = 1 WHERE id = ?', [req.params.id], (err) => {
            checkEscrowRelease(req.params.id, res);
        });
    });
});

app.post('/order/:id/confirm/seller', (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    // Check if order belongs to user (seller)
    // We need to join products to check seller_id
    db.get('SELECT o.*, p.seller_id FROM orders o JOIN products p ON o.product_id = p.id WHERE o.id = ?', [req.params.id], (err, order) => {
        if (err || !order || order.seller_id !== req.session.user.id) return res.send("Order not found or unauthorized");

        db.run('UPDATE orders SET seller_confirmed = 1 WHERE id = ?', [req.params.id], (err) => {
            checkEscrowRelease(req.params.id, res);
        });
    });
});

function checkEscrowRelease(orderId, res) {
    db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, order) => {
        if (order.buyer_confirmed && order.seller_confirmed && !order.escrow_released) {
            // Release funds!
            db.get('SELECT seller_id FROM products WHERE id = ?', [order.product_id], (err, product) => {
                const sellerId = product.seller_id;
                const releaseAmount = order.seller_amount;

                db.serialize(() => {
                    db.run('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [releaseAmount, sellerId]);
                    db.run('UPDATE orders SET escrow_released = 1, status = "completed" WHERE id = ?', [orderId]);
                });

                // If we were using Paystack Transfers, we would initiate a transfer to the seller's subaccount here.
                // axios.post('https://api.paystack.co/transfer', { amount: releaseAmount * 100, recipient: 'RCP_xxxx' })

                return res.redirect('back'); // Reload page
            });
        } else {
            return res.redirect('back');
        }
    });
}

// Ad Purchase Routes
app.get('/ads/buy', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.redirect('/login');
    res.render('buy_ad', { user: req.session.user });
});

app.post('/ads/initialize', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.status(403).send("Unauthorized");
    const { message, category } = req.body;

    let amount = 0;
    let duration = 0;

    switch(category) {
        case 'bronze': amount = 2000; duration = 3; break;
        case 'silver': amount = 3000; duration = 7; break;
        case 'gold': amount = 5000; duration = 30; break;
        default: return res.send("Invalid Category");
    }

    // Ads go 100% to platform (main account)
    const authUrl = `/paystack/verify-ad?reference=AD_${Math.floor(Math.random() * 1000000)}&message=${encodeURIComponent(message)}&amount=${amount}&category=${category}&duration=${duration}`;
    res.redirect(authUrl);
});

app.get('/paystack/verify-ad', (req, res) => {
    const { reference, message, amount, category, duration } = req.query;

    // Calculate Expiry Date (Current Time + Duration in Days)
    const expiryDate = Date.now() + (parseInt(duration) * 24 * 60 * 60 * 1000);

    db.run('INSERT INTO ads (seller_id, message, amount, category, expiry_date, status, payment_reference) VALUES (?, ?, ?, ?, ?, "active", ?)',
        [req.session.user.id, message, parseFloat(amount), category, expiryDate, reference],
        (err) => {
            if (err) console.error(err);
            res.redirect('/seller/dashboard');
        }
    );
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

app.post('/signup',
    [
        body('username').trim().isLength({ min: 3 }).escape(),
        body('password').isLength({ min: 5 }),
        body('role').isIn(['buyer', 'seller'])
    ],
    (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

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
