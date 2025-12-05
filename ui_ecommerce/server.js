require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo').default;
const bcrypt = require('bcrypt');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const { body, validationResult } = require('express-validator');
const { connectDB, User, Product, Order, Ad } = require('./db');
const path = require('path');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_placeholder';

async function verifyPayment(reference) {
    try {
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                },
            }
        );
        return response.data;
    } catch (error) {
        console.error("Paystack verification error:", error.response?.data || error);
        return null;
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Connect to MongoDB
connectDB();

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
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/ui_ecommerce'
    }),
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Set to true in production
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
const checkBlocked = async (req, res, next) => {
    if (req.session.user) {
        try {
            const user = await User.findById(req.session.user._id);
            if (user && user.is_blocked) {
                req.session.destroy();
                return res.send("Your account has been blocked by the admin. Please contact support.");
            }
            next();
        } catch (err) {
            next(err);
        }
    } else {
        next();
    }
};

app.use(checkBlocked);

// Routes

// Home
app.get('/', async (req, res) => {
    try {
        const products = await Product.find();
        const now = new Date();
        const ads = await Ad.find({ status: 'active', expiry_date: { $gt: now } }).sort({ _id: -1 }).limit(3);
        res.render('index', { user: req.session.user, products: products, ads: ads || [] });
    } catch (err) {
        console.error(err);
        res.send("Error loading home");
    }
});

// Admin Routes
app.get('/admin/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');

    try {
        const sellers = await User.find({ role: 'seller' });
        const buyers = await User.find({ role: 'buyer' });
        res.render('admin_dashboard', { user: req.session.user, sellers: sellers, buyers: buyers });
    } catch (err) {
        console.error(err);
        res.send("Error loading admin dashboard");
    }
});

app.post('/admin/block/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send("Unauthorized");
    try {
        await User.findByIdAndUpdate(req.params.id, { is_blocked: true });
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.send("Error blocking user");
    }
});

app.post('/admin/unblock/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).send("Unauthorized");
    try {
        await User.findByIdAndUpdate(req.params.id, { is_blocked: false });
        res.redirect('/admin/dashboard');
    } catch (err) {
        console.error(err);
        res.send("Error unblocking user");
    }
});

// Seller Routes
app.get('/seller/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.redirect('/login');

    try {
        const products = await Product.find({ seller_id: req.session.user._id });
        // Find orders containing products sold by this user
        // This is complex in Mongo without deep population, but let's do:
        // Find all products by seller -> get their IDs -> Find orders with those product_ids
        const productIds = products.map(p => p._id);
        const orders = await Order.find({ product_id: { $in: productIds } });

        res.render('seller_dashboard', { user: req.session.user, products: products, orders: orders });
    } catch (err) {
        console.error(err);
        res.send("Error loading dashboard");
    }
});

app.post('/seller/add-product', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.status(403).send("Unauthorized");

    const { title, description, price } = req.body;
    try {
        await Product.create({
            title,
            description,
            price,
            seller_id: req.session.user._id
        });
        res.redirect('/seller/dashboard');
    } catch (err) {
        console.error(err);
        res.send("Error adding product");
    }
});

// Buyer Routes
app.get('/buyer/dashboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'buyer') return res.redirect('/login');

    try {
        // Find orders for this buyer and populate product info
        const orders = await Order.find({ buyer_id: req.session.user._id }).populate('product_id');

        // Map to format expected by view (orders having product_title, etc.)
        const formattedOrders = orders.map(order => {
            const ord = order.toObject(); // Convert to JS object
            ord.id = ord._id; // Map _id to id for compatibility if needed
            if (ord.product_id) {
                ord.product_title = ord.product_id.title;
            } else {
                ord.product_title = "Unknown Product";
            }
            return ord;
        });

        res.render('buyer_dashboard', { user: req.session.user, orders: formattedOrders });
    } catch (err) {
        console.error(err);
        res.send("Error loading orders");
    }
});

app.get('/buy/:id', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.send("Product not found");

        const price = product.price;
        const serviceFee = price * 0.10;

        // Pass product with .id accessible (Mongoose uses ._id, but sometimes .id virtual exists)
        // Ensure views use .id or ._id consistently. Ideally update views or map here.
        // For simplicity, passing product directly but templates use .id. Mongoose adds .id virtual by default.
        res.render('checkout', { user: req.session.user, product: product, serviceFee: serviceFee });
    } catch (err) {
        console.error(err);
        res.send("Error loading checkout");
    }
});

// Seller Onboarding (Paystack)
app.post('/seller/onboard', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'seller') return res.status(403).send("Unauthorized");
    const { bank_name, account_number, bank_code } = req.body;

    const mockSubaccountCode = 'ACCT_' + Math.floor(Math.random() * 1000000);

    try {
        await User.findByIdAndUpdate(req.session.user._id, {
            bank_name,
            account_number,
            paystack_subaccount_code: mockSubaccountCode
        });
        // Update session user to reflect changes
        req.session.user.bank_name = bank_name;
        req.session.user.account_number = account_number;

        res.redirect('/seller/dashboard');
    } catch (err) {
        console.error(err);
        res.send("Error onboarding");
    }
});

app.post('/paystack/initialize', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const { productId } = req.body;

    try {
        const product = await Product.findById(productId);
        if (!product) return res.send("Product not found");

        const amount = product.price;
        const seller = await User.findById(product.seller_id);

        if (!seller) return res.send("Seller info not found");

        // Simulation URL
        const authUrl = `/paystack/verify?reference=REF_${Math.floor(Math.random() * 1000000)}&productId=${product._id}&amount=${amount}`;
        res.redirect(authUrl);
    } catch (err) {
        console.error(err);
        res.send("Error initializing payment");
    }
});

app.get('/paystack/verify', async (req, res) => {
    const { reference, productId, amount } = req.query;

    const verification = await verifyPayment(reference);

    let productPrice = parseFloat(amount);
    let isVerified = false;

    if (verification && verification.status === true) {
        if (verification.data && verification.data.amount) {
             productPrice = verification.data.amount / 100;
        }
        isVerified = true;
    } else if (PAYSTACK_SECRET_KEY.startsWith('sk_test_placeholder')) {
        // Simulation fallback
        isVerified = true;
    }

    if (isVerified) {
        const serviceFee = productPrice * 0.10;
        const sellerAmount = productPrice - serviceFee;

        try {
            await Order.create({
                buyer_id: req.session.user._id,
                product_id: productId,
                amount: productPrice,
                service_fee: serviceFee,
                seller_amount: sellerAmount,
                status: 'paid',
                payment_reference: reference,
                buyer_confirmed: false,
                seller_confirmed: false,
                escrow_released: false
            });
            res.send(`Payment Successful! Funds held in Escrow until delivery is confirmed by both parties. <a href="/">Go Home</a>`);
        } catch (err) {
            console.error(err);
            res.send("Error processing order");
        }
    } else {
        res.send("Payment verification failed.");
    }
});

// Confirmation & Escrow Release Routes
app.post('/order/:id/confirm/buyer', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    try {
        const order = await Order.findOne({ _id: req.params.id, buyer_id: req.session.user._id });
        if (!order) return res.send("Order not found or unauthorized");

        order.buyer_confirmed = true;
        await order.save();
        await checkEscrowRelease(order._id, res);
    } catch (err) {
        console.error(err);
        res.send("Error confirming order");
    }
});

app.post('/order/:id/confirm/seller', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');

    try {
        // Verify seller owns the product in the order
        const order = await Order.findById(req.params.id).populate('product_id');
        if (!order || !order.product_id || order.product_id.seller_id.toString() !== req.session.user._id.toString()) {
            return res.send("Order not found or unauthorized");
        }

        order.seller_confirmed = true;
        await order.save();
        await checkEscrowRelease(order._id, res);
    } catch (err) {
        console.error(err);
        res.send("Error confirming order");
    }
});

async function checkEscrowRelease(orderId, res) {
    try {
        const order = await Order.findById(orderId).populate('product_id');
        if (order.buyer_confirmed && order.seller_confirmed && !order.escrow_released) {
            // Release funds
            const sellerId = order.product_id.seller_id;
            const releaseAmount = order.seller_amount;

            // Transaction? For simplicity just update
            await User.findByIdAndUpdate(sellerId, { $inc: { wallet_balance: releaseAmount } });

            order.escrow_released = true;
            order.status = 'completed';
            await order.save();

            return res.redirect('back');
        } else {
            return res.redirect('back');
        }
    } catch (err) {
        console.error(err);
        res.send("Error releasing escrow");
    }
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

    const authUrl = `/paystack/verify-ad?reference=AD_${Math.floor(Math.random() * 1000000)}&message=${encodeURIComponent(message)}&amount=${amount}&category=${category}&duration=${duration}`;
    res.redirect(authUrl);
});

app.get('/paystack/verify-ad', async (req, res) => {
    const { reference, message, amount, category, duration } = req.query;

    const verification = await verifyPayment(reference);
    let isVerified = false;

    if ((verification && verification.status === true) || PAYSTACK_SECRET_KEY.startsWith('sk_test_placeholder')) {
        isVerified = true;
    }

    if (isVerified) {
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + parseInt(duration));

        try {
            await Ad.create({
                seller_id: req.session.user._id,
                message,
                amount: parseFloat(amount),
                category,
                expiry_date: expiryDate,
                status: 'active',
                payment_reference: reference
            });
            res.redirect('/seller/dashboard');
        } catch (err) {
            console.error(err);
            res.send("Error saving ad");
        }
    } else {
        res.send("Ad Payment verification failed.");
    }
});

// Auth Routes
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.redirect('/login');

        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.user = user; // Mongoose document
            if (user.role === 'seller') return res.redirect('/seller/dashboard');
            return res.redirect('/');
        }
        res.redirect('/login');
    } catch (err) {
        console.error(err);
        res.redirect('/login');
    }
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
    async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { username, password, role } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);

    try {
        await User.create({
            username,
            password: hashedPassword,
            role
        });
        res.redirect('/login');
    } catch (err) {
        console.error("SIGNUP ERROR:", err);
        res.status(500).send("Error creating user (Username might be taken)");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
