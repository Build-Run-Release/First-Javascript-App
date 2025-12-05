const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ui_ecommerce');
        console.log('MongoDB Connected');
        await initAdmin();
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
        process.exit(1);
    }
};

// Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['buyer', 'seller', 'admin'], required: true },
    balance: { type: Number, default: 0 },
    wallet_balance: { type: Number, default: 0 },
    is_blocked: { type: Boolean, default: false },
    bank_name: String,
    account_number: String,
    paystack_subaccount_code: String
});

const productSchema = new mongoose.Schema({
    title: String,
    description: String,
    price: Number,
    seller_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    image_url: String
});

const orderSchema = new mongoose.Schema({
    buyer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    amount: Number,
    service_fee: Number,
    seller_amount: Number,
    status: String,
    buyer_confirmed: { type: Boolean, default: false },
    seller_confirmed: { type: Boolean, default: false },
    escrow_released: { type: Boolean, default: false },
    payment_reference: String
});

const adSchema = new mongoose.Schema({
    seller_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    message: String,
    amount: Number,
    category: String,
    expiry_date: Date,
    status: String,
    payment_reference: String
});

// Models
const User = mongoose.model('User', userSchema);
const Product = mongoose.model('Product', productSchema);
const Order = mongoose.model('Order', orderSchema);
const Ad = mongoose.model('Ad', adSchema);

async function initAdmin() {
    try {
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
            const hashedPassword = bcrypt.hashSync('admin123', 10);
            await User.create({
                username: 'admin',
                password: hashedPassword,
                role: 'admin'
            });
            console.log('Default Admin created');
        }
    } catch (e) {
        console.error("Admin init error", e);
    }
}

module.exports = { connectDB, User, Product, Order, Ad };
